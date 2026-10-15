import type { Schema } from 'shared';
import type { ApplicationRoleRow, ApplicationRow } from '../repositories/application.repository.js';

export type ApplicationDto = Schema<'SearchApplication'>;

/** Roles are listed by priority; `isActive` and the bookkeeping columns are internal. */
export function toApplicationDto(
  row: ApplicationRow,
  roles: readonly ApplicationRoleRow[],
): ApplicationDto {
  return {
    id: row.id,
    status: row.status as ApplicationDto['status'],
    enqueuedAt: row.enqueuedAt.toISOString(),
    roles: [...roles]
      .sort((a, b) => a.priority - b.priority)
      .map((role) => ({
        roleCode: role.roleCode,
        priority: role.priority,
        addedAt: role.addedAt.toISOString(),
      })),
    version: row.version,
  };
}
