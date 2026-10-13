import type { Schema } from 'shared';
import { inviteeHint, shownStatus } from '../domain/invitation-rules.js';
import type { InvitationRow } from '../repositories/invitation.repository.js';

export type InvitationDto = Schema<'Invitation'>;

/** The token and its hash never appear here; an overdue `active` row is shown as `expired`. */
export function toInvitationDto(row: InvitationRow, roleCode: string, now: Date): InvitationDto {
  return {
    id: row.id,
    seatId: row.seatId,
    roleCode,
    inviteeHint: inviteeHint(row),
    status: shownStatus(row, now) as InvitationDto['status'],
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
