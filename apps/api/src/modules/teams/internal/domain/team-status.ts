import type { ErrorCode } from './team-rules.types.js';

/** Team statuses (FR-TEAM-27, `teams.team_status_check`). */
export const TEAM_STATUSES = [
  'forming',
  'active',
  'voting',
  'suspended',
  'completed',
  'archived',
] as const;
export type TeamStatusName = (typeof TEAM_STATUSES)[number];

/** C-06: maximum length of a project, counted from its start. */
export const MAX_PROJECT_DAYS = 120;
const DAY_MS = 86_400_000;

/** Reason written to `team.status_reason` by the `max-duration-scan` timer. */
export const MAX_DURATION_REASON = 'max_duration';

/**
 * Allowed status changes (FR-TEAM-27, architecture 8.2). Anything outside this table is a
 * forbidden transition. `voting` returns to the status the team had before the vote
 * (`status_before_vote`: forming or active); a failed vote suspends or archives the team;
 * `suspended` is resumed to forming/active or archived when the suspension expires.
 */
const TRANSITIONS: Readonly<Record<TeamStatusName, readonly TeamStatusName[]>> = {
  forming: ['active', 'voting', 'suspended', 'archived'],
  active: ['voting', 'suspended', 'completed'],
  voting: ['forming', 'active', 'suspended', 'archived'],
  suspended: ['forming', 'active', 'voting', 'archived'],
  completed: ['archived'],
  archived: [],
};

function isStatus(value: string): value is TeamStatusName {
  return (TEAM_STATUSES as readonly string[]).includes(value);
}

/** Whether the status machine has an edge `from -> to`. Unknown statuses have none. */
export function canTransition(from: string, to: string): boolean {
  if (!isStatus(from) || !isStatus(to)) return false;
  return TRANSITIONS[from].includes(to);
}

/** `INVALID_STATE` (409) for a forbidden transition, `undefined` when it is allowed. */
export function transitionError(from: string, to: string): ErrorCode | undefined {
  return canTransition(from, to) ? undefined : 'INVALID_STATE';
}

/**
 * Whether a team in this status refuses the actions of its lead (changing the card, seats,
 * offers, starting). While a vote runs or the project is suspended only voting and resuming are
 * possible: 409 `TEAM_STATUS_BLOCKS_ACTION`. Finished teams keep their seat marks for the reward
 * snapshot (FR-TEAM-03): 409 `INVALID_STATE`.
 */
export function statusBlock(status: string): ErrorCode | undefined {
  if (status === 'completed' || status === 'archived') return 'INVALID_STATE';
  if (status === 'voting' || status === 'suspended') return 'TEAM_STATUS_BLOCKS_ACTION';
  return undefined;
}

/** What `startProject` answers for a team in this status (`undefined`: it may start). */
export function startError(status: string): ErrorCode | undefined {
  return statusBlock(status) ?? transitionError(status, 'active');
}

/**
 * Planned end of the project (FR-WORK-12): the length of the pinned playbook, never beyond the
 * maximum duration C-06.
 */
export function plannedEnd(startedAt: Date, playbookDays: number | null): Date {
  const days = Math.min(playbookDays ?? MAX_PROJECT_DAYS, MAX_PROJECT_DAYS);
  return new Date(startedAt.getTime() + days * DAY_MS);
}

/**
 * C-06 / FR-TEAM-27: whether an active project has run for the maximum duration. The time a
 * project spent suspended does not count (FR-WORK-18).
 */
export function maxDurationReached(
  team: { status: string; startedAt: Date | null; suspendedTotalSeconds: number },
  now: Date,
): boolean {
  if (team.status !== 'active' || team.startedAt === null) return false;
  const limit =
    team.startedAt.getTime() + MAX_PROJECT_DAYS * DAY_MS + team.suspendedTotalSeconds * 1000;
  return now.getTime() >= limit;
}
