import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { contribution } from '../schema/contribution.js';
import { checklistItem } from '../schema/stage.js';

export type ContributionRow = typeof contribution.$inferSelect;

export interface FeedFilter {
  teamId: string;
  userId?: string | undefined;
  source?: ContributionRow['source'] | undefined;
}

export interface FeedPosition {
  at: Date;
  id: string;
}

export interface SummaryCount {
  userId: string;
  roleCode: string;
  source: string;
  count: number;
}

/** Reads of `workspace.contribution` for the feed and the summary (FR-WORK-16). Every query starts with the team. */
@Injectable()
export class FeedRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** Newest first; the key `(received_at, id)` is unique, so pages neither repeat nor skip rows. */
  async page(
    filter: FeedFilter,
    after: FeedPosition | undefined,
    take: number,
  ): Promise<ContributionRow[]> {
    const conditions: SQL[] = [eq(contribution.teamId, filter.teamId)];
    if (filter.userId !== undefined) conditions.push(eq(contribution.userId, filter.userId));
    if (filter.source !== undefined) conditions.push(eq(contribution.source, filter.source));
    if (after !== undefined) {
      const older = or(
        lt(contribution.receivedAt, after.at),
        and(eq(contribution.receivedAt, after.at), lt(contribution.id, after.id)),
      );
      if (older !== undefined) conditions.push(older);
    }
    return this.tx.tx
      .select()
      .from(contribution)
      .where(and(...conditions))
      .orderBy(desc(contribution.receivedAt), desc(contribution.id))
      .limit(take);
  }

  /** Counts of the contributions that count (`active`), per member, role and source. */
  async countActive(teamId: string): Promise<SummaryCount[]> {
    return this.tx.tx
      .select({
        userId: contribution.userId,
        roleCode: contribution.roleCode,
        source: contribution.source,
        count: sql<number>`count(*)::int`,
      })
      .from(contribution)
      .where(and(eq(contribution.teamId, teamId), eq(contribution.active, true)))
      .groupBy(contribution.userId, contribution.roleCode, contribution.source);
  }

  /** Items left without an executor when their holder departed (FR-TEAM-13): the list "tasks without an executor". */
  async unassignedItemIds(teamId: string): Promise<string[]> {
    const rows = await this.tx.tx
      .select({ id: checklistItem.id })
      .from(checklistItem)
      .where(
        and(
          eq(checklistItem.teamId, teamId),
          eq(checklistItem.status, 'open'),
          isNull(checklistItem.assigneeUserId),
          isNotNull(checklistItem.unassignedFromUserId),
        ),
      )
      .orderBy(checklistItem.stepKey, checklistItem.id);
    return rows.map((row) => row.id);
  }
}
