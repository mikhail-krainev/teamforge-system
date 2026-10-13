import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { departure, seat } from '../schema/teams.js';

export type DepartureRow = typeof departure.$inferSelect;

export interface DepartureCursor {
  dueAt: Date;
  id: string;
}

/** `teams.departure`: the lead's decision after a member left (FR-TEAM-12). */
@Injectable()
export class DepartureRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  async insert(row: typeof departure.$inferInsert): Promise<void> {
    await this.tx.tx.insert(departure).values(row);
  }

  /** Newest due date first, keyset `(due_at, id)`; served by `departure_team_idx`. */
  list(teamId: string, after: DepartureCursor | undefined, limit: number): Promise<DepartureRow[]> {
    return this.tx.tx
      .select()
      .from(departure)
      .where(
        and(
          eq(departure.teamId, teamId),
          after === undefined
            ? undefined
            : sql`(${departure.dueAt}, ${departure.id}) < (${after.dueAt.toISOString()}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(departure.dueAt), desc(departure.id))
      .limit(limit);
  }

  async find(departureId: string): Promise<DepartureRow | undefined> {
    const rows = await this.tx.tx.select().from(departure).where(eq(departure.id, departureId));
    return rows[0];
  }

  async decide(
    departureId: string,
    decision: 'replace' | 'continue',
    decidedBy: string | null,
    at: Date,
  ): Promise<void> {
    await this.tx.tx
      .update(departure)
      .set({ decision, decidedAt: at, decidedBy })
      .where(eq(departure.id, departureId));
  }

  /** Role codes of the given seats, for the DTO. */
  async rolesOfSeats(seatIds: string[]): Promise<Map<string, string>> {
    if (seatIds.length === 0) return new Map();
    const rows = await this.tx.tx
      .select({ id: seat.id, roleCode: seat.roleCode })
      .from(seat)
      .where(inArray(seat.id, seatIds));
    return new Map(rows.map((row) => [row.id, row.roleCode]));
  }
}
