import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { Clock } from '../../../../platform/clock/clock.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import type { AccountCheckView, PullRequestStats, RepositoryFacts } from '../../public.js';
import { evaluateAccount } from '../domain/account-rules.js';
import { accountCheck, repoCheck, repoLink } from '../schema/repo.js';
import { ghItem } from '../schema/webhook.js';
import { RepoLinkRepository } from './repo-link.repository.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const UNKNOWN_ACCOUNT: AccountCheckView = {
  eligibility: { status: 'unknown', reasons: [] },
  ageDays: null,
  hasPublicActivity: null,
};

/**
 * What the anti-fraud rules of rewards read from github (AF-01, AF-03, AF-05, AF-16, FR-GH-09): stored state
 * only, never a call to GitHub, so rewards may read it before its transaction.
 */
@Injectable()
export class AntifraudFactsService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
  ) {}

  /** The account check of each user: two statements however many users (accounts without a check are `unknown`). */
  async accountChecks(userIds: string[]): Promise<Map<string, AccountCheckView>> {
    const facts = await this.auth.getAccountFacts(userIds);
    const githubIds = [...facts.values()].flatMap((f) =>
      f.githubUserId === null ? [] : [f.githubUserId],
    );
    const rows =
      githubIds.length === 0
        ? []
        : await this.tx.tx
            .select()
            .from(accountCheck)
            .where(inArray(accountCheck.githubUserId, githubIds));
    const byGithub = new Map(rows.map((r) => [r.githubUserId, r]));
    const now = this.clock.now();
    return new Map(
      userIds.map((userId) => {
        const githubId = facts.get(userId)?.githubUserId ?? null;
        const row = githubId === null ? undefined : byGithub.get(githubId);
        if (row === undefined) return [userId, UNKNOWN_ACCOUNT];
        const verdict = evaluateAccount(row, now);
        const view: AccountCheckView = {
          eligibility: {
            status: verdict.eligible ? 'eligible' : 'pending_account',
            reasons: verdict.reasons,
          },
          ageDays: Math.floor((now.getTime() - row.accountCreatedAt.getTime()) / DAY_MS),
          hasPublicActivity: row.hasPublicActivity || row.publicRepos > 0,
        };
        return [userId, view];
      }),
    );
  }

  /** AF-05: changed lines of the merged pull requests of the team's repository and the share of the biggest one. */
  async pullRequestStats(teamId: string): Promise<PullRequestStats> {
    const link = await this.links.findHolding(teamId);
    if (link === undefined) return { changedLines: 0, maxPrShare: 0 };
    const lines = sql<number>`coalesce(${ghItem.additions}, 0) + coalesce(${ghItem.deletions}, 0)`;
    const [row] = await this.tx.tx
      .select({
        total: sql<number>`coalesce(sum(${lines}), 0)::int`,
        biggest: sql<number>`coalesce(max(${lines}), 0)::int`,
      })
      .from(ghItem)
      .where(
        and(
          eq(ghItem.repositoryId, link.repositoryId),
          eq(ghItem.kind, 'pr'),
          eq(ghItem.merged, true),
        ),
      );
    const total = row?.total ?? 0;
    return { changedLines: total, maxPrShare: total === 0 ? 0 : (row?.biggest ?? 0) / total };
  }

  /** AF-01, AF-03: the repository of the project, `null` when the team has none. */
  async repositoryFacts(teamId: string): Promise<RepositoryFacts | null> {
    const link = await this.links.findHolding(teamId);
    if (link === undefined) return null;
    const [other] = await this.tx.tx
      .select({ id: repoLink.id })
      .from(repoLink)
      .where(
        and(
          eq(repoLink.repositoryId, link.repositoryId),
          eq(repoLink.status, 'completed'),
          ne(repoLink.teamId, teamId),
        ),
      )
      .limit(1);
    const [final] = await this.tx.tx
      .select({ details: repoCheck.details })
      .from(repoCheck)
      .where(and(eq(repoCheck.teamId, teamId), eq(repoCheck.kind, 'final')))
      .orderBy(desc(repoCheck.checkedAt))
      .limit(1);
    const reasons = (final?.details as { reasons?: unknown } | undefined)?.reasons;
    return {
      repositoryId: link.repositoryId,
      createdAt: link.repoCreatedAt,
      heldByOtherProject: other !== undefined,
      forkWithoutOwnCommits: Array.isArray(reasons) && reasons.includes('REPO_FORK'),
    };
  }
}
