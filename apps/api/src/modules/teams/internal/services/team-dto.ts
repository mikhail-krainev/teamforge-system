import type { Schema } from 'shared';
import type { SeatWithHolder } from '../repositories/seat.repository.js';
import type { TeamRow } from '../repositories/team.repository.js';

export type TeamDto = Schema<'Team'>;
export type SeatDto = Schema<'Seat'>;
export type MemberDto = Schema<'Member'>;
export type TeamSummaryDto = Schema<'TeamSummary'>;
export type TeamEventDto = Schema<'TeamEvent'>;

const iso = (value: Date): string => value.toISOString();
const isoOrNull = (value: Date | null): string | null => (value === null ? null : iso(value));

export function toSeatDto(row: SeatWithHolder): SeatDto {
  return {
    id: row.id,
    roleCode: row.roleCode,
    ordinal: row.ordinal,
    desired: row.desired,
    minLevel: row.minLevel as SeatDto['minLevel'],
    minHours: row.minHours,
    stack: row.stack,
    status: row.status as SeatDto['status'],
    holderUserId: row.holderUserId,
    desiredChangedAt: isoOrNull(row.desiredChangedAt),
    openedAt: isoOrNull(row.openedAt),
    version: row.version,
  };
}

export function toTeamDto(
  row: TeamRow,
  parts: {
    playbookVersion: string;
    seats: SeatDto[];
    members: MemberDto[];
    plannedEndAt: Date | null;
  },
): TeamDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    timezone: row.timezone,
    hoursPerWeek: row.hoursPerWeek,
    productTypeCode: row.productTypeCode,
    playbookId: row.playbookId,
    playbookVersion: parts.playbookVersion,
    leadUserId: row.leadUserId,
    status: row.status as TeamDto['status'],
    statusReason: row.statusReason,
    startedAt: isoOrNull(row.startedAt),
    plannedEndAt: isoOrNull(parts.plannedEndAt),
    completedAt: isoOrNull(row.completedAt),
    releaseUrl: row.releaseUrl,
    memberCount: row.memberCount,
    seats: parts.seats,
    members: parts.members,
    version: row.version,
    createdAt: iso(row.createdAt),
  };
}
