import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { ACTIVE_PROJECT_STATUSES } from '../domain/team-rules.js';
import { membership, seatAssignment, team } from '../schema/teams.js';

export type TeamRow = typeof team.$inferSelect;
export type MembershipRow = typeof membership.$inferSelect;
export type AssignmentRow = typeof seatAssignment.$inferSelect;

/** Writes and single-team reads of `teams.team` / `teams.membership` (architecture 3.4). */
@Injectable()
export class TeamRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  async insertTeam(row: typeof team.$inferInsert): Promise<void> {
    await this.tx.tx.insert(team).values(row);
  }

  async insertMembership(row: typeof membership.$inferInsert): Promise<void> {
    await this.tx.tx.insert(membership).values(row);
  }

  async find(teamId: string): Promise<TeamRow | undefined> {
    const rows = await this.tx.tx.select().from(team).where(eq(team.id, teamId));
    return rows[0];
  }

  async update(teamId: string, set: Partial<typeof team.$inferInsert>): Promise<void> {
    await this.tx.tx.update(team).set(set).where(eq(team.id, teamId));
  }

  /** C-04 counter: open + filled seats; the caller holds the team lock. */
  async adjustSeatCount(teamId: string, delta: number, now: Date): Promise<void> {
    await this.tx.tx
      .update(team)
      .set({ seatCount: sql`${team.seatCount} + ${delta}`, updatedAt: now })
      .where(eq(team.id, teamId));
  }

  /**
   * FR-TEAM-05: projects of the user that count against C-10. Called under the user lock (#1),
   * so a parallel create or join of the same user waits and sees the committed result.
   */
  async countActiveProjects(userId: string): Promise<number> {
    const rows = await this.tx.tx
      .select({ count: sql<number>`count(*)::int` })
      .from(membership)
      .innerJoin(team, eq(team.id, membership.teamId))
      .where(
        and(
          eq(membership.userId, userId),
          eq(membership.status, 'active'),
          inArray(team.status, [...ACTIVE_PROJECT_STATUSES]),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  /** Whether PostgreSQL itself accepts the name in `AT TIME ZONE` (the catalog filter relies on it). */
  async isKnownTimezone(name: string): Promise<boolean> {
    const rows = await this.tx.tx.execute(
      sql`SELECT 1 AS ok FROM pg_timezone_names WHERE name = ${name} LIMIT 1`,
    );
    return rows.length > 0;
  }

  activeMembers(teamId: string): Promise<MembershipRow[]> {
    return this.tx.tx
      .select()
      .from(membership)
      .where(and(eq(membership.teamId, teamId), eq(membership.status, 'active')))
      .orderBy(membership.joinedAt, membership.id);
  }

  activeAssignments(teamId: string): Promise<AssignmentRow[]> {
    return this.tx.tx
      .select()
      .from(seatAssignment)
      .where(and(eq(seatAssignment.teamId, teamId), isNull(seatAssignment.endedAt)));
  }
}
