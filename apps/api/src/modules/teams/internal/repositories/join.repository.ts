import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { membership, seat, seatAssignment, team } from '../schema/teams.js';
import type { MembershipRow } from './team.repository.js';

/** Reads and writes of the join path (T1): membership, seat assignment and the member counter. */
@Injectable()
export class JoinRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** The team of a seat, read without a lock (the lock on the team is taken next). */
  async teamOfSeat(seatId: string): Promise<string | undefined> {
    const rows = await this.tx.tx
      .select({ teamId: seat.teamId })
      .from(seat)
      .where(eq(seat.id, seatId));
    return rows[0]?.teamId;
  }

  async activeMembership(teamId: string, userId: string): Promise<MembershipRow | undefined> {
    const rows = await this.tx.tx
      .select()
      .from(membership)
      .where(
        and(
          eq(membership.teamId, teamId),
          eq(membership.userId, userId),
          eq(membership.status, 'active'),
        ),
      );
    return rows[0];
  }

  async heldRoles(membershipId: string): Promise<string[]> {
    const rows = await this.tx.tx
      .select({ roleCode: seatAssignment.roleCode })
      .from(seatAssignment)
      .where(and(eq(seatAssignment.membershipId, membershipId), isNull(seatAssignment.endedAt)));
    return rows.map((row) => row.roleCode);
  }

  async insertAssignment(row: typeof seatAssignment.$inferInsert): Promise<void> {
    await this.tx.tx.insert(seatAssignment).values(row);
  }

  /** C-02 counter; the caller holds the team lock and has checked `member_count < 8`. */
  async addMember(teamId: string, now: Date): Promise<void> {
    await this.tx.tx
      .update(team)
      .set({ memberCount: sql`${team.memberCount} + 1`, updatedAt: now })
      .where(eq(team.id, teamId));
  }

  /** Seats currently held through a membership; the caller holds the team lock. */
  activeAssignments(
    membershipId: string,
  ): Promise<{ id: string; seatId: string; roleCode: string }[]> {
    return this.tx.tx
      .select({
        id: seatAssignment.id,
        seatId: seatAssignment.seatId,
        roleCode: seatAssignment.roleCode,
      })
      .from(seatAssignment)
      .where(and(eq(seatAssignment.membershipId, membershipId), isNull(seatAssignment.endedAt)));
  }

  async endAssignments(membershipId: string, at: Date): Promise<void> {
    await this.tx.tx
      .update(seatAssignment)
      .set({ endedAt: at })
      .where(and(eq(seatAssignment.membershipId, membershipId), isNull(seatAssignment.endedAt)));
  }

  async markLeft(membershipId: string, at: Date, reason: string): Promise<void> {
    await this.tx.tx
      .update(membership)
      .set({ status: 'left', leftAt: at, leftReason: reason })
      .where(eq(membership.id, membershipId));
  }

  /** C-02 counter; the caller holds the team lock. */
  async removeMember(teamId: string, now: Date): Promise<void> {
    await this.tx.tx
      .update(team)
      .set({ memberCount: sql`${team.memberCount} - 1`, updatedAt: now })
      .where(eq(team.id, teamId));
  }
}
