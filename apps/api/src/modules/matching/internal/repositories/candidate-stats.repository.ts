import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { candidateStats } from '../schema/matching.js';

/** `matching.candidate_stats`: completed projects per user and role (projection of rewards). */
@Injectable()
export class CandidateStatsRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** Completed projects of the users in one role; users without a row are absent. */
  async completedInRole(userIds: string[], roleCode: string): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.tx.tx
      .select({ userId: candidateStats.userId, count: candidateStats.completedCount })
      .from(candidateStats)
      .where(and(inArray(candidateStats.userId, userIds), eq(candidateStats.roleCode, roleCode)));
    return new Map(rows.map((row) => [row.userId, row.count]));
  }

  /** Completed projects of one user per role. */
  async completedByRole(userId: string): Promise<Map<string, number>> {
    const rows = await this.tx.tx
      .select({ roleCode: candidateStats.roleCode, count: candidateStats.completedCount })
      .from(candidateStats)
      .where(eq(candidateStats.userId, userId));
    return new Map(rows.map((row) => [row.roleCode, row.count]));
  }

  /** Sets the counters of the user; a counter is replaced, never added (the event is at-least-once). */
  async setCounters(userId: string, counters: ReadonlyMap<string, number>): Promise<void> {
    if (counters.size === 0) return;
    await this.tx.tx
      .insert(candidateStats)
      .values(
        [...counters].map(([roleCode, completedCount]) => ({ userId, roleCode, completedCount })),
      )
      .onConflictDoUpdate({
        target: [candidateStats.userId, candidateStats.roleCode],
        set: { completedCount: sql`excluded.completed_count` },
      });
  }
}
