import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import {
  applicationExclusion,
  applicationRole,
  matchCandidate,
  searchApplication,
} from '../schema/matching.js';

export type MatchCandidateRow = typeof matchCandidate.$inferSelect;
export type MatchCandidateInsert = typeof matchCandidate.$inferInsert;

/** Rows per INSERT of a recompute (architecture 6.3: batches of 500). */
export const WRITE_BATCH = 500;

/** The active application of a user as the recompute needs it. */
export interface QueueEntry {
  applicationId: string;
  enqueuedAt: Date;
  roles: Set<string>;
}

/** Keyset position in a list ordered by score descending and then by a unique id. */
export interface ScoreCursor {
  score: string;
  id: string;
}

/** `matching.match_candidate` (precomputed recommendations) and the queue facts a recompute reads. */
@Injectable()
export class RecommendRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /**
   * Upserts a batch without a window of an empty list: an older parallel recompute never overwrites
   * a newer one (`computed_at` guard, architecture 6.3).
   */
  async upsert(rows: MatchCandidateInsert[]): Promise<void> {
    for (let from = 0; from < rows.length; from += WRITE_BATCH) {
      await this.tx.tx
        .insert(matchCandidate)
        .values(rows.slice(from, from + WRITE_BATCH))
        .onConflictDoUpdate({
          target: [matchCandidate.seatId, matchCandidate.userId],
          set: {
            teamId: sql`excluded.team_id`,
            roleCode: sql`excluded.role_code`,
            score: sql`excluded.score`,
            reasons: sql`excluded.reasons`,
            inQueue: sql`excluded.in_queue`,
            computedAt: sql`excluded.computed_at`,
          },
          setWhere: sql`${matchCandidate.computedAt} <= excluded.computed_at`,
        });
    }
  }

  /** Pairs of the seat that did not pass the filters in the run that started at `startedAt`. */
  async deleteStaleForSeat(seatId: string, keptUserIds: string[], startedAt: Date): Promise<void> {
    await this.tx.tx
      .delete(matchCandidate)
      .where(
        and(
          eq(matchCandidate.seatId, seatId),
          lte(matchCandidate.computedAt, startedAt),
          keptUserIds.length === 0 ? undefined : notInArray(matchCandidate.userId, keptUserIds),
        ),
      );
  }

  async deleteStaleForUser(userId: string, keptSeatIds: string[], startedAt: Date): Promise<void> {
    await this.tx.tx
      .delete(matchCandidate)
      .where(
        and(
          eq(matchCandidate.userId, userId),
          lte(matchCandidate.computedAt, startedAt),
          keptSeatIds.length === 0 ? undefined : notInArray(matchCandidate.seatId, keptSeatIds),
        ),
      );
  }

  /** Rows of seats of the team that are not open any more (closed, filled, team not recruiting). */
  async deleteClosedSeatsOfTeam(teamId: string, openSeatIds: string[]): Promise<void> {
    await this.tx.tx
      .delete(matchCandidate)
      .where(
        and(
          eq(matchCandidate.teamId, teamId),
          openSeatIds.length === 0 ? undefined : notInArray(matchCandidate.seatId, openSeatIds),
        ),
      );
  }

  async deleteBySeat(seatId: string): Promise<void> {
    await this.tx.tx.delete(matchCandidate).where(eq(matchCandidate.seatId, seatId));
  }

  async deleteByUser(userId: string): Promise<void> {
    await this.tx.tx.delete(matchCandidate).where(eq(matchCandidate.userId, userId));
  }

  /** Candidates of a seat, best first; `limit` rows after the cursor. */
  listForSeat(
    seatId: string,
    after: ScoreCursor | undefined,
    limit: number,
  ): Promise<MatchCandidateRow[]> {
    return this.tx.tx
      .select()
      .from(matchCandidate)
      .where(
        and(
          eq(matchCandidate.seatId, seatId),
          after === undefined
            ? undefined
            : or(
                lt(matchCandidate.score, after.score),
                and(eq(matchCandidate.score, after.score), gt(matchCandidate.userId, after.id)),
              ),
        ),
      )
      .orderBy(desc(matchCandidate.score), asc(matchCandidate.userId))
      .limit(limit);
  }

  /** Recommended seats of a user, best first, optionally of one role. */
  listForUser(
    userId: string,
    roleCode: string | undefined,
    after: ScoreCursor | undefined,
    limit: number,
  ): Promise<MatchCandidateRow[]> {
    return this.tx.tx
      .select()
      .from(matchCandidate)
      .where(
        and(
          eq(matchCandidate.userId, userId),
          roleCode === undefined ? undefined : eq(matchCandidate.roleCode, roleCode),
          after === undefined
            ? undefined
            : or(
                lt(matchCandidate.score, after.score),
                and(eq(matchCandidate.score, after.score), gt(matchCandidate.seatId, after.id)),
              ),
        ),
      )
      .orderBy(desc(matchCandidate.score), asc(matchCandidate.seatId))
      .limit(limit);
  }

  /**
   * Teams that excluded the people in the trial period (FR-MATCH-08), whatever application records
   * it and whether the person is in the queue now: one statement for any number of users.
   */
  async excludedTeams(userIds: string[]): Promise<Map<string, Set<string>>> {
    const byUser = new Map<string, Set<string>>();
    if (userIds.length === 0) return byUser;
    const rows = await this.tx.tx
      .select({ userId: searchApplication.userId, teamId: applicationExclusion.teamId })
      .from(applicationExclusion)
      .innerJoin(searchApplication, eq(searchApplication.id, applicationExclusion.applicationId))
      .where(inArray(searchApplication.userId, userIds));
    for (const row of rows) {
      const teams = byUser.get(row.userId) ?? new Set<string>();
      teams.add(row.teamId);
      byUser.set(row.userId, teams);
    }
    return byUser;
  }

  /** Active applications of the users with their roles: one statement for any number of users. */
  async queueEntries(userIds: string[]): Promise<Map<string, QueueEntry>> {
    const entries = new Map<string, QueueEntry>();
    if (userIds.length === 0) return entries;
    const db = this.tx.tx;
    const rows = await db
      .select({
        userId: searchApplication.userId,
        applicationId: searchApplication.id,
        enqueuedAt: searchApplication.enqueuedAt,
        roleCode: applicationRole.roleCode,
      })
      .from(searchApplication)
      .innerJoin(applicationRole, eq(applicationRole.applicationId, searchApplication.id))
      .where(
        and(inArray(searchApplication.userId, userIds), eq(searchApplication.status, 'active')),
      );
    const byApplication = new Map<string, QueueEntry>();
    for (const row of rows) {
      const entry = byApplication.get(row.applicationId) ?? {
        applicationId: row.applicationId,
        enqueuedAt: row.enqueuedAt,
        roles: new Set<string>(),
      };
      entry.roles.add(row.roleCode);
      byApplication.set(row.applicationId, entry);
      entries.set(row.userId, entry);
    }
    return entries;
  }
}
