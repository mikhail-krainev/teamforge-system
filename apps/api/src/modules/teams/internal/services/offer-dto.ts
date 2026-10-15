import type { Schema } from 'shared';
import type { OfferRow } from '../repositories/offer.repository.js';

export type OfferDto = Schema<'SeatOffer'>;
export type JoinResultDto = Schema<'JoinResult'>;

/** A `pending` offer past its term is shown as `expired` even before the sweeper rewrites it. */
export function toOfferDto(row: OfferRow, roleCode: string, now: Date): OfferDto {
  const overdue = row.status === 'pending' && row.expiresAt <= now;
  return {
    id: row.id,
    teamId: row.teamId,
    seatId: row.seatId,
    roleCode,
    direction: row.direction as OfferDto['direction'],
    userId: row.userId,
    status: (overdue ? 'expired' : row.status) as OfferDto['status'],
    message: row.message,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
