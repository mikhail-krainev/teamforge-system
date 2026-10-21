import { DomainError } from '../../../../platform/errors/domain-error.js';

/**
 * What the status of the team allows for the check and for the completion (FR-WORK-13 (7), FR-TEAM-27):
 * only an `active` project. A finished or archived one answers `INVALID_STATE` (also the second "Завершить"),
 * a vote or a suspension `TEAM_STATUS_BLOCKS_ACTION`, a project that has not started `INVALID_STATE`.
 */
export function assertCompletable(status: string): void {
  if (status === 'suspended' || status === 'voting') {
    throw new DomainError('TEAM_STATUS_BLOCKS_ACTION', 409);
  }
  if (status !== 'active') throw new DomainError('INVALID_STATE', 409);
}
