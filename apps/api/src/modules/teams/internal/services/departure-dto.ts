import type { Schema } from 'shared';
import type { DepartureRow } from '../repositories/departure.repository.js';

export type DepartureDto = Schema<'Departure'>;

/**
 * `unassignedItemIds` stays empty until workspace owns checklists (slice 5, FR-TEAM-13); the field
 * is part of the contract already.
 */
export function toDepartureDto(row: DepartureRow, roles: Map<string, string>): DepartureDto {
  return {
    id: row.id,
    userId: row.userId,
    seatIds: row.seatIds,
    roleCodes: row.seatIds.flatMap((id) => roles.get(id) ?? []),
    reason: row.reason as DepartureDto['reason'],
    decision: row.decision as DepartureDto['decision'],
    dueAt: row.dueAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    unassignedItemIds: [],
  };
}
