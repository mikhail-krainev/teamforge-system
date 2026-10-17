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
    return (await this.completedByUsers([userId])).get(userId) ?? new Map();
  }

  /** Completed projects per role of several users, one statement; users without rows are absent. */
  async completedByUsers(userIds: string[]): Promise<Map<string, Map<string, number>>> {
    const byUser = new Map<string, Map<string, number>>();
    if (userIds.length === 0) return byUser;
    const rows = await this.tx.tx
      .select({
        userId: candidateStats.userId,
        roleCode: candidateStats.roleCode,
        count: candidateStats.completedCount,
      })
      .from(candidateStats)
      .where(inArray(candidateStats.userId, userIds));
    for (const row of rows) {
      const roles = byUser.get(row.userId) ?? new Map<string, number>();
      roles.set(row.roleCode, row.count);
      byUser.set(row.userId, roles);
    }
    return byUser;
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
