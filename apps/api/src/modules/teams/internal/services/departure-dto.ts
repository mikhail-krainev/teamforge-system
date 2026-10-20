import type { Schema } from 'shared';
import type { DepartureRow } from '../repositories/departure.repository.js';

export type DepartureDto = Schema<'Departure'>;

/** `unassignedItemIds` comes from workspace (FR-TEAM-13): the items the leaver carried, per member. */
export function toDepartureDto(
  row: DepartureRow,
  roles: Map<string, string>,
  unassigned: ReadonlyMap<string, string[]> = new Map(),
): DepartureDto {
  return {
    id: row.id,
    userId: row.userId,
    seatIds: row.seatIds,
    roleCodes: row.seatIds.flatMap((id) => roles.get(id) ?? []),
    reason: row.reason as DepartureDto['reason'],
    decision: row.decision as DepartureDto['decision'],
    dueAt: row.dueAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    unassignedItemIds: unassigned.get(row.userId) ?? [],
  };
}
