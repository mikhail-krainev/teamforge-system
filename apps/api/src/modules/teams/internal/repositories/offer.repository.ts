import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, lte, or, sql, type SQL } from 'drizzle-orm';
import { registerConstraint } from '../../../../platform/errors/constraints.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { seat, seatOffer } from '../schema/teams.js';

// Final guards of the join path (CC-1, FR-TEAM-07, FR-TEAM-28): the services check first, the
// indexes decide when two requests still get through.
registerConstraint('seat_assignment_active_role_uq', { code: 'ALREADY_MEMBER', status: 409 });
registerConstraint('membership_active_uq', { code: 'ALREADY_MEMBER', status: 409 });
registerConstraint('seat_offer_pending_uq', { code: 'INVALID_STATE', status: 409 });

export type OfferRow = typeof seatOffer.$inferSelect;
export interface OfferWithRole {
  offer: OfferRow;
  roleCode: string;
}

export interface OfferCursor {
  at: Date;
  id: string;
}

/** Offers still waiting for an answer: `pending` and not past their term. */
const waiting = (now: Date): SQL | undefined =>
  and(eq(seatOffer.status, 'pending'), gt(seatOffer.expiresAt, now));

/** Status filter of the lists; an overdue `pending` row counts as `expired` before the sweeper runs. */
function statusFilter(status: string | undefined, now: Date): SQL | undefined {
  if (status === undefined) return undefined;
  if (status === 'pending') return waiting(now);
  if (status !== 'expired') return eq(seatOffer.status, status);
  return or(
    eq(seatOffer.status, 'expired'),
    and(eq(seatOffer.status, 'pending'), lte(seatOffer.expiresAt, now)),
  );
}

/** `teams.seat_offer`: offers of the lead and requests of candidates (FR-TEAM-28..30). */
@Injectable()
export class OfferRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  async insert(row: typeof seatOffer.$inferInsert): Promise<void> {
    await this.tx.tx.insert(seatOffer).values(row);
  }

  async find(offerId: string): Promise<OfferRow | undefined> {
    const rows = await this.tx.tx.select().from(seatOffer).where(eq(seatOffer.id, offerId));
    return rows[0];
  }

  async setStatus(offerId: string, status: string, decidedAt: Date): Promise<void> {
    await this.tx.tx.update(seatOffer).set({ status, decidedAt }).where(eq(seatOffer.id, offerId));
  }

  /** An overdue pending row keeps its slot in `seat_offer_pending_uq`; free it before a new one. */
  async expireStale(seatId: string, userId: string, now: Date): Promise<void> {
    await this.tx.tx
      .update(seatOffer)
      .set({ status: 'expired', decidedAt: now })
      .where(
        and(
          eq(seatOffer.seatId, seatId),
          eq(seatOffer.userId, userId),
          eq(seatOffer.status, 'pending'),
          lte(seatOffer.expiresAt, now),
        ),
      );
  }

  async hasPending(seatId: string, userId: string, now: Date): Promise<boolean> {
    const rows = await this.tx.tx
      .select({ id: seatOffer.id })
      .from(seatOffer)
      .where(and(eq(seatOffer.seatId, seatId), eq(seatOffer.userId, userId), waiting(now)))
      .limit(1);
    return rows.length > 0;
  }

  /** FR-TEAM-28: pending offers of the lead; counted under the team lock. */
  countPendingOffers(teamId: string, now: Date): Promise<number> {
    return this.countWaiting(
      and(eq(seatOffer.teamId, teamId), eq(seatOffer.direction, 'lead_to_user')),
      now,
    );
  }

  /** FR-TEAM-29: pending requests of one candidate over all teams; counted under lock #1. */
  countPendingRequests(userId: string, now: Date): Promise<number> {
    return this.countWaiting(
      and(eq(seatOffer.userId, userId), eq(seatOffer.direction, 'user_to_lead')),
      now,
    );
  }

  private async countWaiting(scope: SQL | undefined, now: Date): Promise<number> {
    const rows = await this.tx.tx
      .select({ count: sql<number>`count(*)::int` })
      .from(seatOffer)
      .where(and(scope, waiting(now)));
    return rows[0]?.count ?? 0;
  }

  /** Newest first, keyset `(created_at, id)`; the role comes from the seat in the same query. */
  listForTeam(
    teamId: string,
    status: string | undefined,
    now: Date,
    after: OfferCursor | undefined,
    limit: number,
  ): Promise<OfferWithRole[]> {
    return this.list(and(eq(seatOffer.teamId, teamId), statusFilter(status, now)), after, limit);
  }

  listForUser(
    userId: string,
    after: OfferCursor | undefined,
    limit: number,
  ): Promise<OfferWithRole[]> {
    return this.list(eq(seatOffer.userId, userId), after, limit);
  }

  private list(scope: SQL | undefined, after: OfferCursor | undefined, limit: number) {
    return this.tx.tx
      .select({ offer: seatOffer, roleCode: seat.roleCode })
      .from(seatOffer)
      .innerJoin(seat, eq(seat.id, seatOffer.seatId))
      .where(
        and(
          scope,
          after === undefined
            ? undefined
            : sql`(${seatOffer.createdAt}, ${seatOffer.id}) < (${after.at.toISOString()}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(seatOffer.createdAt), desc(seatOffer.id))
      .limit(limit);
  }
}
