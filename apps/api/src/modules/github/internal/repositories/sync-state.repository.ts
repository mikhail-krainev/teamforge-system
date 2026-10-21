import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import type { MergedPull, ReviewFact } from '../domain/review-rules.js';
import { accountCheck, repoCheck, repoLink, repoSyncState } from '../schema/repo.js';
import { ghItem, ghPrReview } from '../schema/webhook.js';

export type SyncStateRow = typeof repoSyncState.$inferSelect;
export type AccountCheckRow = typeof accountCheck.$inferSelect;
export type ActiveLink = Pick<
  typeof repoLink.$inferSelect,
  'teamId' | 'repositoryId' | 'installationId' | 'fullName'
>;

/** The fields of `repo_sync_state` a run changes; the ones left out stay as they were. */
export type SyncStatePatch = Partial<Omit<SyncStateRow, 'repositoryId'>>;

/** `repo_sync_state`, `account_check`, `repo_check` and the reads the checks make of `gh_item` and `gh_pr_review`. */
@Injectable()
export class SyncStateRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  async activeLinks(): Promise<ActiveLink[]> {
    return this.tx.tx
      .select({
        teamId: repoLink.teamId,
        repositoryId: repoLink.repositoryId,
        installationId: repoLink.installationId,
        fullName: repoLink.fullName,
      })
      .from(repoLink)
      .where(eq(repoLink.status, 'active'))
      .orderBy(repoLink.linkedAt);
  }

  async state(repositoryId: number): Promise<SyncStateRow | undefined> {
    const [row] = await this.tx.tx
      .select()
      .from(repoSyncState)
      .where(eq(repoSyncState.repositoryId, repositoryId))
      .limit(1);
    return row;
  }

  async saveState(repositoryId: number, patch: SyncStatePatch): Promise<void> {
    await this.tx.tx
      .insert(repoSyncState)
      .values({ repositoryId, ...patch })
      .onConflictDoUpdate({ target: repoSyncState.repositoryId, set: patch });
  }

  async recordRepoCheck(check: {
    teamId: string;
    repositoryId: number;
    kind: 'exists' | 'final';
    ok: boolean;
    details: Record<string, unknown>;
    checkedAt: Date;
  }): Promise<void> {
    // Rows are read newest first: two checks of one instant (a clock that stands still) keep the order they were made in.
    const [latest] = await this.tx.tx
      .select({ checkedAt: repoCheck.checkedAt })
      .from(repoCheck)
      .where(and(eq(repoCheck.teamId, check.teamId), eq(repoCheck.kind, check.kind)))
      .orderBy(desc(repoCheck.checkedAt))
      .limit(1);
    const checkedAt =
      latest !== undefined && latest.checkedAt.getTime() >= check.checkedAt.getTime()
        ? new Date(latest.checkedAt.getTime() + 1)
        : check.checkedAt;
    await this.tx.tx.insert(repoCheck).values({ id: uuidv7(), ...check, checkedAt });
  }

  async accountChecks(githubUserIds: number[]): Promise<AccountCheckRow[]> {
    if (githubUserIds.length === 0) return [];
    return this.tx.tx
      .select()
      .from(accountCheck)
      .where(inArray(accountCheck.githubUserId, githubUserIds));
  }

  async saveAccountCheck(row: AccountCheckRow): Promise<void> {
    await this.tx.tx
      .insert(accountCheck)
      .values(row)
      .onConflictDoUpdate({
        target: accountCheck.githubUserId,
        set: {
          accountCreatedAt: row.accountCreatedAt,
          publicRepos: row.publicRepos,
          hasPublicActivity: row.hasPublicActivity,
          checkedAt: row.checkedAt,
        },
      });
  }

  async mergedPulls(repositoryId: number): Promise<MergedPull[]> {
    return this.tx.tx
      .select({ number: ghItem.number, authorGithubId: ghItem.authorGithubId })
      .from(ghItem)
      .where(
        and(eq(ghItem.repositoryId, repositoryId), eq(ghItem.kind, 'pr'), eq(ghItem.merged, true)),
      );
  }

  async reviews(repositoryId: number): Promise<ReviewFact[]> {
    return this.tx.tx
      .select({
        prNumber: ghPrReview.prNumber,
        reviewerGithubId: ghPrReview.reviewerGithubId,
        state: ghPrReview.state,
      })
      .from(ghPrReview)
      .where(eq(ghPrReview.repositoryId, repositoryId));
  }
}
