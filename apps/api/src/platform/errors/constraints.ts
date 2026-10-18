import type { ErrorCode } from 'shared';

export interface ConstraintMapping {
  code: ErrorCode;
  status: number;
}

/**
 * Unique-index name -> error code (architecture 13.1). Index names are significant: renaming a
 * unique index in a migration without updating this registry turns a 409 into a 500.
 */
const registry = new Map<string, ConstraintMapping>([
  ['seat_assignment_active_seat_uq', { code: 'SEAT_TAKEN', status: 409 }],
  ['repo_link_repository_uq', { code: 'REPO_TAKEN', status: 409 }],
  ['repo_link_team_active_uq', { code: 'INVALID_STATE', status: 409 }],
  ['search_application_active_uq', { code: 'APPLICATION_EXISTS', status: 409 }],
  ['leader_vote_open_uq', { code: 'VOTE_ALREADY_OPEN', status: 409 }],
  ['vote_ballot_pk', { code: 'ALREADY_VOTED', status: 409 }],
  ['project_stage_one_open_uq', { code: 'STAGE_NOT_OPEN', status: 409 }],
]);

/** Called by module schema files to register their own unique-index mappings. */
export function registerConstraint(name: string, mapping: ConstraintMapping): void {
  const existing = registry.get(name);
  if (existing && (existing.code !== mapping.code || existing.status !== mapping.status)) {
    throw new Error(`Constraint ${name} is already registered with a different mapping`);
  }
  registry.set(name, mapping);
}

export function lookupConstraint(name: string | undefined): ConstraintMapping | undefined {
  return name === undefined ? undefined : registry.get(name);
}
