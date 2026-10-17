import type { FieldError } from '../../../../platform/errors/domain-error.js';

/** C-07: a queue application carries 1..5 roles. */
export const MAX_APPLICATION_ROLES = 5;

export interface RoleInput {
  roleCode: string;
  priority: number;
}

export interface StoredRole extends RoleInput {
  addedAt: Date;
}

/** Roles and priorities must each be unique within one application (FR-MATCH-03); 422 otherwise. */
export function roleErrors(roles: readonly RoleInput[]): FieldError[] {
  const errors: FieldError[] = [];
  const seenRoles = new Set<string>();
  const seenPriorities = new Set<number>();
  roles.forEach((role, index) => {
    if (seenRoles.has(role.roleCode)) {
      errors.push({
        pointer: `/roles/${index}/roleCode`,
        code: 'duplicate_role',
        message: 'A role may appear only once',
      });
    }
    if (seenPriorities.has(role.priority)) {
      errors.push({
        pointer: `/roles/${index}/priority`,
        code: 'duplicate_priority',
        message: 'Priorities must be unique',
      });
    }
    seenRoles.add(role.roleCode);
    seenPriorities.add(role.priority);
  });
  return errors;
}

export interface RoleChange {
  /** Roles dropped from the application. */
  removed: string[];
  /** Kept roles whose priority changed; `addedAt` is preserved. */
  reprioritized: RoleInput[];
  /** New roles; `addedAt` of these is the time of the change (FR-MATCH-06). */
  added: RoleInput[];
  changed: boolean;
}

/** What an update does to the stored roles; an identical set is not a change (no version bump). */
export function diffRoles(stored: readonly StoredRole[], next: readonly RoleInput[]): RoleChange {
  const byCode = new Map(stored.map((role) => [role.roleCode, role]));
  const nextCodes = new Set(next.map((role) => role.roleCode));
  const removed = stored.filter((role) => !nextCodes.has(role.roleCode)).map((r) => r.roleCode);
  const added = next.filter((role) => !byCode.has(role.roleCode));
  const reprioritized = next.filter((role) => {
    const current = byCode.get(role.roleCode);
    return current !== undefined && current.priority !== role.priority;
  });
  return {
    removed,
    reprioritized,
    added,
    changed: removed.length + added.length + reprioritized.length > 0,
  };
}
