import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import type { AccountEligibility, RepoExistsResult, RepoFinalResult } from '../../public.js';
import { GithubClient, type RepositoryDetail } from '../client/github-client.js';
import { RepositoryReader } from '../client/repository-reader.js';
import { evaluateAccount } from '../domain/account-rules.js';
import { type CiState, ciStateOf } from '../domain/ci-rules.js';
import { evaluateRepoFinal } from '../domain/repo-final-rules.js';
import { crossReviewedPullCount } from '../domain/review-rules.js';
import { SyncStateRepository } from '../repositories/sync-state.repository.js';
import { MemberAttribution } from '../webhook/member-attribution.service.js';
import { RepoInspectionService } from './repo-inspection.service.js';
import { RepoLinkRepository } from './repo-link.repository.js';

const NO_REPOSITORY = 'NO_REPOSITORY';

/** The repository a check is about: where it is and who holds it. */
export interface CheckedRepository {
  teamId: string;
  repositoryId: number;
  installationId: number;
}

/**
 * The checks of the repository and of the accounts (FR-GH-08, FR-GH-09, architecture 7.4): `repo_exists`
 * and `repo_final` with their rows in `repo_check`, `ci_workflow`, `pr_cross_review`. The rules are pure
 * functions of `domain/`; this class collects their facts from GitHub and from the stored state.
 */
@Injectable()
export class RepoChecksService {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(RepoInspectionService) private readonly inspection: RepoInspectionService,
    @Inject(GithubClient) private readonly github: GithubClient,
    @Inject(RepositoryReader) private readonly reader: RepositoryReader,
    @Inject(SyncStateRepository) private readonly state: SyncStateRepository,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
    @Inject(MemberAttribution) private readonly attribution: MemberAttribution,
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
  ) {}

  /** `repo_exists` (exists, not archived, public, not a fork without own commits), recorded as kind `exists`. */
  async exists(
    repo: CheckedRepository,
  ): Promise<{ result: RepoExistsResult; repository: RepositoryDetail | null }> {
    const { repository, rejections } = await this.inspection.inspect(
      repo.installationId,
      repo.repositoryId,
    );
    const result = {
      ok: rejections.length === 0,
      reasons: rejections as string[],
      checkedAt: this.clock.now(),
    };
    await this.state.recordRepoCheck({
      teamId: repo.teamId,
      repositoryId: repo.repositoryId,
      kind: 'exists',
      ok: result.ok,
      details: { reasons: result.reasons },
      checkedAt: result.checkedAt,
    });
    return { result, repository };
  }

  /** `repo_final` (FR-GH-08): the verdict, recorded as kind `final`. GitHub failing rejects; nothing is recorded. */
  async final(teamId: string): Promise<RepoFinalResult> {
    const link = await this.links.findHolding(teamId);
    const checkedAt = this.clock.now();
    if (link === undefined) {
      return { ok: false, reasons: [NO_REPOSITORY], commits: 0, committingMembers: 0, checkedAt };
    }
    const { repository, rejections } = await this.inspection.inspect(
      link.installationId,
      link.repositoryId,
    );
    const facts =
      repository === null
        ? { commits: 0, committingMembers: 0 }
        : await this.commitFacts(teamId, link.installationId, link.repositoryId);
    const verdict = evaluateRepoFinal({ rejections, ...facts });
    await this.state.recordRepoCheck({
      teamId,
      repositoryId: link.repositoryId,
      kind: 'final',
      ok: verdict.ok,
      details: { reasons: verdict.reasons, ...facts },
      checkedAt,
    });
    return { ok: verdict.ok, reasons: verdict.reasons, ...facts, checkedAt };
  }

  /** Commits of the repository and how many members of the team made them (numeric GitHub ids, never logins). */
  private async commitFacts(
    teamId: string,
    installationId: number,
    repositoryId: number,
  ): Promise<{ commits: number; committingMembers: number }> {
    const contributors = await this.github.listContributors(installationId, repositoryId);
    const committers = contributors.filter((c) => c.contributions > 0).map((c) => c.id);
    const members = await this.attribution.membersByGithubId(teamId, committers);
    return {
      commits: contributors.reduce((sum, c) => sum + c.contributions, 0),
      committingMembers: new Set(members.values()).size,
    };
  }

  /** `ci_workflow`: reads the latest runs and keeps the verdict in `repo_sync_state`. `null`: not checked. */
  async refreshCiState(repo: CheckedRepository, defaultBranch: string): Promise<CiState | null> {
    const runs = await this.reader.listWorkflowRuns(repo.installationId, repo.repositoryId);
    const ciState = ciStateOf(runs, defaultBranch);
    await this.state.saveState(repo.repositoryId, { ciState, ciCheckedAt: this.clock.now() });
    return ciState;
  }

  /** The stored verdict of `ci_workflow` for the repository of the team; `null` when never checked. */
  async ciState(teamId: string): Promise<CiState | null> {
    const link = await this.links.findHolding(teamId);
    if (link === undefined) return null;
    const stored = (await this.state.state(link.repositoryId))?.ciState;
    return stored === 'success' || stored === 'none' ? stored : null;
  }

  /** `pr_cross_review:N` reads this: merged pull requests with a review by somebody who is not the author. */
  async crossReviewedPulls(teamId: string): Promise<number> {
    const link = await this.links.findHolding(teamId);
    if (link === undefined) return 0;
    const [pulls, reviews] = await Promise.all([
      this.state.mergedPulls(link.repositoryId),
      this.state.reviews(link.repositoryId),
    ]);
    return crossReviewedPullCount(pulls, reviews);
  }

  /** FR-GH-09 from the stored `account_check`; `unknown` while the account was not looked at. */
  async accountEligibility(userId: string): Promise<AccountEligibility> {
    const identity = await this.auth.getIdentity(userId);
    if (identity?.githubUserId == null) return { status: 'unknown', reasons: [] };
    const [row] = await this.state.accountChecks([identity.githubUserId]);
    if (row === undefined) return { status: 'unknown', reasons: [] };
    const verdict = evaluateAccount(row, this.clock.now());
    return {
      status: verdict.eligible ? 'eligible' : 'pending_account',
      reasons: verdict.reasons,
    };
  }

  /** The members of the team that have a linked GitHub account, as `[userId, githubUserId]`. */
  async memberGithubIds(teamId: string): Promise<[string, number][]> {
    const roster = await this.teams.getRoster(teamId);
    const pairs = await Promise.all(
      roster.map(async (member) => {
        const identity = await this.auth.getIdentity(member.userId);
        return [member.userId, identity?.githubUserId ?? null] as const;
      }),
    );
    return pairs.flatMap(([userId, githubId]) => (githubId === null ? [] : [[userId, githubId]]));
  }
}
