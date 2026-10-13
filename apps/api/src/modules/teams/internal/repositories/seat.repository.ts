import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { seat, seatAssignment } from '../schema/teams.js';

export type SeatRow = typeof seat.$inferSelect;
export type SeatWithHolder = SeatRow & { holderUserId: string | null };

/** `teams.seat` access; every method takes the team id, so a foreign seat id is simply not found. */
@Injectable()
export class SeatRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  async insertMany(rows: (typeof seat.$inferInsert)[]): Promise<void> {
    if (rows.length > 0) await this.tx.tx.insert(seat).values(rows);
  }

  /** Highest ordinal ever used per role, closed seats included. One query for all roles. */
  async highestOrdinals(teamId: string, roleCodes: string[]): Promise<Map<string, number>> {
    if (roleCodes.length === 0) return new Map();
    const rows = await this.tx.tx
      .select({ roleCode: seat.roleCode, highest: sql<number>`max(${seat.ordinal})::int` })
      .from(seat)
      .where(and(eq(seat.teamId, teamId), inArray(seat.roleCode, roleCodes)))
      .groupBy(seat.roleCode);
    return new Map(rows.map((row) => [row.roleCode, row.highest]));
  }

  /** Seats of a team with the current holder (at most one active assignment per seat, CC-1). */
  listByTeam(teamId: string, seatIds?: string[]): Promise<SeatWithHolder[]> {
    return this.tx.tx
      .select({
        id: seat.id,
        teamId: seat.teamId,
        roleCode: seat.roleCode,
        ordinal: seat.ordinal,
        desired: seat.desired,
        desiredChangedAt: seat.desiredChangedAt,
        minLevel: seat.minLevel,
        minHours: seat.minHours,
        stack: seat.stack,
        status: seat.status,
        openedAt: seat.openedAt,
        version: seat.version,
        holderUserId: seatAssignment.userId,
      })
      .from(seat)
      .leftJoin(
        seatAssignment,
        and(eq(seatAssignment.seatId, seat.id), isNull(seatAssignment.endedAt)),
      )
      .where(
        and(eq(seat.teamId, teamId), seatIds === undefined ? undefined : inArray(seat.id, seatIds)),
      )
      .orderBy(asc(seat.roleCode), asc(seat.ordinal));
  }

  async update(seatId: string, set: Partial<typeof seat.$inferInsert>): Promise<void> {
    await this.tx.tx.update(seat).set(set).where(eq(seat.id, seatId));
  }
}
