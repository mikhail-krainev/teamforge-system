import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { ghItem, ghPrReview } from '../schema/webhook.js';

export type ItemRow = typeof ghItem.$inferSelect;

/** What an event says about an issue or a pull request. */
export interface ItemWrite {
  repositoryId: number;
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  htmlUrl: string;
  authorGithubId: number | null;
  assigneeGithubIds: number[];
  state: 'open' | 'closed';
  merged: boolean;
  labels: string[];
  additions: number | null;
  deletions: number | null;
  closedAt: Date | null;
  mergedAt: Date | null;
  /** `updated_at` on GitHub: an older event never overwrites a newer one (SEC-06); see `supersedes` for equal stamps. */
  sourceUpdatedAt: Date;
  receivedAt: Date;
}

export interface UpsertResult {
  /** False: the stored row is as new as the event or newer, nothing changed. */
  applied: boolean;
  /** The row before the event; `undefined` when the item was not known. */
  previous: ItemRow | undefined;
}

const EPOCH = new Date(0);

/** How far an item has come: a state does not go back inside one second of `updated_at`. */
export function itemRank(item: { state: string; merged: boolean }): number {
  if (item.merged) return 2;
  return item.state === 'closed' ? 1 : 0;
}

/** What of an item decides whether another version of it with the same `updated_at` still says something. */
export interface ItemStamp {
  sourceUpdatedAt: Date;
  state: string;
  merged: boolean;
  labels: readonly string[];
  assigneeGithubIds: readonly number[];
}

const sameMembers = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((value) => b.includes(value));

/**
 * True when `incoming` is news for the stored version. GitHub stamps whole seconds, so two changes of
 * one second (assigned, then closed by a script) carry the same `updated_at`: inside the same second
 * the version that went further (open, closed, merged) wins, and at the same step one that differs in
 * labels or assignees is applied (writing the same content again is harmless). A strictly older stamp never is.
 */
export function supersedes(incoming: ItemStamp, stored: ItemStamp): boolean {
  const byTime = incoming.sourceUpdatedAt.getTime() - stored.sourceUpdatedAt.getTime();
  if (byTime !== 0) return byTime > 0;
  const byStep = itemRank(incoming) - itemRank(stored);
  if (byStep !== 0) return byStep > 0;
  return (
    !sameMembers(incoming.labels, stored.labels) ||
    !sameMembers(incoming.assigneeGithubIds, stored.assigneeGithubIds)
  );
}

/** `github.gh_item` and `github.gh_pr_review`: what the webhooks and the reconciliation know of the repository. */
@Injectable()
export class ItemRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  async find(
    repositoryId: number,
    kind: 'issue' | 'pr',
    number: number,
    lock = false,
  ): Promise<ItemRow | undefined> {
    const query = this.tx.tx
      .select()
      .from(ghItem)
      .where(
        and(
          eq(ghItem.repositoryId, repositoryId),
          eq(ghItem.kind, kind),
          eq(ghItem.number, number),
        ),
      )
      .limit(1);
    const [row] = await (lock ? query.for('update') : query);
    return row;
  }

  /**
   * Conditional upsert (architecture 7.3 item 4): `INSERT`, and on a conflict the row is locked and
   * rewritten only by an event that `supersedes` what it holds. `closer_pr_number` and the time of
   * the first sighting survive.
   */
  async upsert(write: ItemWrite): Promise<UpsertResult> {
    const values = {
      repositoryId: write.repositoryId,
      kind: write.kind,
      number: write.number,
      title: write.title,
      htmlUrl: write.htmlUrl,
      authorGithubId: write.authorGithubId,
      assigneeGithubIds: write.assigneeGithubIds,
      state: write.state,
      merged: write.merged,
      labels: write.labels,
      additions: write.additions,
      deletions: write.deletions,
      closedAt: write.closedAt,
      mergedAt: write.mergedAt,
      sourceUpdatedAt: write.sourceUpdatedAt,
      updatedAt: write.receivedAt,
    };
    const inserted = await this.tx.tx
      .insert(ghItem)
      .values({ ...values, firstReceivedAt: write.receivedAt })
      .onConflictDoNothing()
      .returning({ number: ghItem.number });
    if (inserted.length === 1) return { applied: true, previous: undefined };
    const previous = await this.find(write.repositoryId, write.kind, write.number, true);
    if (previous === undefined) return this.upsert(write);
    if (!supersedes(write, previous)) {
      return { applied: false, previous };
    }
    await this.tx.tx
      .update(ghItem)
      .set(values)
      .where(
        and(
          eq(ghItem.repositoryId, write.repositoryId),
          eq(ghItem.kind, write.kind),
          eq(ghItem.number, write.number),
        ),
      );
    return { applied: true, previous };
  }

  /**
   * A merged pull request promised to close issue `number`. The issue may not be known yet (its own
   * event comes after the pull request's): a placeholder older than any real event keeps the link,
   * and the first real event replaces everything but the link. Returns the issue as it was, and
   * whether the link was new.
   */
  async setCloser(
    repositoryId: number,
    number: number,
    prNumber: number,
    now: Date,
  ): Promise<{ previous: ItemRow | undefined; linked: boolean }> {
    const inserted = await this.tx.tx
      .insert(ghItem)
      .values({
        repositoryId,
        kind: 'issue',
        number,
        title: '',
        htmlUrl: '',
        state: 'open',
        closerPrNumber: prNumber,
        firstReceivedAt: now,
        updatedAt: now,
        sourceUpdatedAt: EPOCH,
      })
      .onConflictDoNothing()
      .returning({ number: ghItem.number });
    if (inserted.length === 1) return { previous: undefined, linked: true };
    const previous = await this.find(repositoryId, 'issue', number, true);
    if (previous === undefined) return this.setCloser(repositoryId, number, prNumber, now);
    if (previous.closerPrNumber !== null) return { previous, linked: false };
    await this.tx.tx
      .update(ghItem)
      .set({ closerPrNumber: prNumber, updatedAt: now })
      .where(
        and(
          eq(ghItem.repositoryId, repositoryId),
          eq(ghItem.kind, 'issue'),
          eq(ghItem.number, number),
        ),
      );
    return { previous, linked: true };
  }

  /** The last review of the reviewer on the pull request (`pr_cross_review`); an older one changes nothing. */
  async upsertReview(review: {
    repositoryId: number;
    prNumber: number;
    reviewerGithubId: number;
    state: string;
    submittedAt: Date;
  }): Promise<void> {
    await this.tx.tx
      .insert(ghPrReview)
      .values(review)
      .onConflictDoUpdate({
        target: [ghPrReview.repositoryId, ghPrReview.prNumber, ghPrReview.reviewerGithubId],
        set: { state: review.state, submittedAt: review.submittedAt },
        setWhere: sql`${ghPrReview.submittedAt} <= ${review.submittedAt.toISOString()}::timestamptz`,
      });
  }
}
