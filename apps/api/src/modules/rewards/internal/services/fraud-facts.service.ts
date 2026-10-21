import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import {
  AUTH_API,
  type AccountFacts,
  type AuthApi,
  type IdentitySignal,
} from '../../../auth/public.js';
import {
  type AccountCheckView,
  GITHUB_API,
  type GithubApi,
  type PullRequestStats,
  type RepositoryFacts,
} from '../../../github/public.js';
import { TEAMS_API, type TeamBrief, type TeamsApi } from '../../../teams/public.js';
import {
  type AntifraudFacts,
  type CompletionSnapshot,
  WORKSPACE_API,
  type WorkspaceApi,
} from '../../../workspace/public.js';
import { DAY_MS, IDENTITY_WINDOW_MS } from '../domain/constants.js';
import type { ContributionFacts, FraudFacts, MemberFacts, Phase } from '../fraud/rules/facts.js';
import { CreditRepository } from '../repositories/credit.repository.js';
import { CreditRunRepository } from '../repositories/credit-run.repository.js';

const SOURCES: readonly string[] = ['issue', 'pr', 'artifact', 'ritual'];

/** Everything the facts are made of, read in one round (no value depends on another). */
interface Sources {
  brief: TeamBrief | undefined;
  work: AntifraudFacts;
  repo: RepositoryFacts | null;
  pulls: PullRequestStats;
  accounts: Map<string, AccountFacts>;
  checks: Map<string, AccountCheckView>;
  signals: IdentitySignal[];
  lastCredit: Map<string, Date>;
  sameRoster: string[];
}

/**
 * Collects the facts the pure rules read (architecture 10.5): the snapshot of the completion, the stored state
 * of github, workspace and auth and the own tables. Only reads, in a fixed number of statements however big the
 * team is; the rules themselves do no I/O.
 */
@Injectable()
export class FraudFactsService {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Inject(GITHUB_API) private readonly github: GithubApi,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(WORKSPACE_API) private readonly workspace: WorkspaceApi,
    @Inject(CreditRunRepository) private readonly runs: CreditRunRepository,
    @Inject(CreditRepository) private readonly credits: CreditRepository,
  ) {}

  async build(
    teamId: string,
    phase: Phase,
    snapshot: CompletionSnapshot,
    rosterHash: Buffer,
  ): Promise<FraudFacts> {
    const now = this.clock.now();
    const src = await this.read(teamId, snapshot, rosterHash, now);
    const earlier = await this.teams.getTeamBriefs(src.sameRoster);
    const startedAt = new Date(snapshot.startedAt ?? snapshot.completedAt);
    return {
      phase,
      now,
      team: teamFacts(snapshot, src.brief, startedAt),
      stages: src.work.stages.map((s) => ({
        ordinal: s.ordinal,
        status: s.closedAt === null ? 'open' : 'closed',
        plannedDays: s.plannedDays,
        openedAt: s.openedAt,
        closedAt: s.closedAt,
      })),
      members: snapshot.roster.members.map((m) => memberFacts(m, src, now)),
      contributions: contributionFacts(snapshot),
      repository: repositoryFacts(snapshot, src.repo, startedAt),
      release: {
        url: snapshot.releaseUrl ?? '',
        heldByCreditedProject: await this.releaseHeld(teamId),
        placeholderPage: src.work.releasePlaceholder,
      },
      pullRequests: { changedLines: src.pulls.changedLines, maxShare: src.pulls.maxPrShare },
      artifacts: src.work.artifacts,
      earlierProjects: [...earlier.values()].map((b) => ({
        name: b.name,
        description: b.description,
      })),
      sameRosterProjects: src.sameRoster.length + 1,
      desiredMarks: desiredMarks(snapshot),
      identitySignals: src.signals.map((s) => ({
        userId: s.userId,
        kind: s.kind,
        valueHmac: s.valueHmac,
      })),
      // AF-18: the fingerprints of the profile texts belong to profiles, which rewards may not read (FR-REW-13 keeps
      // rewards away from profiles); the rule stays quiet until a port brings them.
      textHolders: {},
      scoreSoFar: 0,
    };
  }

  private async read(
    teamId: string,
    snapshot: CompletionSnapshot,
    rosterHash: Buffer,
    now: Date,
  ): Promise<Sources> {
    const userIds = snapshot.roster.members.map((m) => m.userId);
    const since = new Date(now.getTime() - IDENTITY_WINDOW_MS);
    const [brief, work, repo, pulls, accounts, checks, signals, lastCredit, sameRoster] =
      await Promise.all([
        this.teams.getTeamBriefs([teamId]),
        this.workspace.getAntifraudFacts(teamId),
        this.github.getRepositoryFacts(teamId),
        this.github.getPullRequestStats(teamId),
        this.auth.getAccountFacts(userIds),
        this.github.getAccountChecks(userIds),
        this.auth.getIdentitySignals(userIds, since),
        this.credits.lastOtherCreditAt(userIds, teamId),
        this.runs.sameRosterTeamIds(rosterHash, teamId),
      ]);
    return {
      brief: brief.get(teamId),
      work,
      repo,
      pulls,
      accounts,
      checks,
      signals,
      lastCredit,
      sameRoster,
    };
  }

  /** AF-02: another project of the platform that is not revoked holds the same normalized release address. */
  private async releaseHeld(teamId: string): Promise<boolean> {
    const view = await this.teams.getTeamView(teamId);
    if (view?.releaseKey == null) return false;
    const others = await this.teams.listCompletedTeamsByReleaseKey(view.releaseKey, teamId);
    return (await this.runs.nonRevoked(others)).size > 0;
  }
}

function teamFacts(
  snapshot: CompletionSnapshot,
  brief: TeamBrief | undefined,
  startedAt: Date,
): FraudFacts['team'] {
  return {
    name: brief?.name ?? '',
    description: brief?.description ?? '',
    createdAt: brief?.createdAt ?? startedAt,
    startedAt,
    completedAt: new Date(snapshot.completedAt),
  };
}

function repositoryFacts(
  snapshot: CompletionSnapshot,
  repo: RepositoryFacts | null,
  startedAt: Date,
): FraudFacts['repository'] {
  return {
    id: repo?.repositoryId ?? snapshot.repositoryId ?? 0,
    createdAt: repo?.createdAt ?? startedAt,
    boundToCreditedProject: repo?.heldByOtherProject ?? false,
    forkWithoutOwnCommits: repo?.forkWithoutOwnCommits ?? false,
  };
}

function memberFacts(
  member: CompletionSnapshot['roster']['members'][number],
  src: Sources,
  now: Date,
): MemberFacts {
  const check = src.checks.get(member.userId);
  const last = src.lastCredit.get(member.userId);
  return {
    userId: member.userId,
    registeredAt: src.accounts.get(member.userId)?.registeredAt ?? new Date(member.joinedAt),
    joinedAt: new Date(member.joinedAt),
    tombstoneMatch: src.accounts.get(member.userId)?.tombstoneMatch ?? false,
    textHash: null,
    account:
      check === undefined || check.ageDays === null
        ? null
        : { ageDays: check.ageDays, hasPublicActivity: check.hasPublicActivity ?? false },
    lastOtherCreditDaysAgo:
      last === undefined ? null : Math.floor((now.getTime() - last.getTime()) / DAY_MS),
  };
}

/** The contributions of the snapshot (the ones that are still standing: a reopened task is not in it). */
function contributionFacts(snapshot: CompletionSnapshot): ContributionFacts[] {
  return snapshot.contributions.map((c) => ({
    userId: c.userId,
    source: (SOURCES.includes(c.source) ? c.source : 'issue') as ContributionFacts['source'],
    ref: c.ref,
    active: true,
    receivedAt: new Date(c.receivedAt),
  }));
}

/** AF-14: the marks "желательная" standing at the completion with the time they were set. */
function desiredMarks(snapshot: CompletionSnapshot): { roleCode: string; changedAt: Date }[] {
  return snapshot.roster.seats.flatMap((seat) =>
    seat.desired && seat.desiredChangedAt != null
      ? [{ roleCode: seat.roleCode, changedAt: new Date(seat.desiredChangedAt) }]
      : [],
  );
}
