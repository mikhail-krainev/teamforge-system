import type { ErrorCode, FieldErrorLike } from './team-rules.types.js';

/** C-10: active projects per user (spec section 7). */
export const MAX_ACTIVE_PROJECTS = 2;
/** C-04: open + filled seats per team. */
export const MAX_SEATS = 12;
/** C-02: members per team. */
export const MAX_MEMBERS = 8;

/** Team statuses that count as an active project of a member (FR-TEAM-05). */
export const ACTIVE_PROJECT_STATUSES = ['forming', 'active', 'voting', 'suspended'] as const;
/** Statuses shown in the team catalog (index `team_catalog_idx`). */
export const CATALOG_STATUSES = ['forming', 'active'] as const;

export interface SeatInputLike {
  roleCode: string;
  desired: boolean;
  minLevel: string;
  minHours: number;
  stack: string[];
  count?: number | undefined;
}

export interface SeatSpec {
  roleCode: string;
  desired: boolean;
  minLevel: string;
  minHours: number;
  stack: string[];
}

/** One spec per seat: `count` copies of each input (default 1), stack tags de-duplicated. */
export function expandSeats(inputs: readonly SeatInputLike[]): SeatSpec[] {
  return inputs.flatMap((input) =>
    Array.from({ length: input.count ?? 1 }, () => ({
      roleCode: input.roleCode,
      desired: input.desired,
      minLevel: input.minLevel,
      minHours: input.minHours,
      stack: [...new Set(input.stack)],
    })),
  );
}

/** C-04: `existing` seats (open + filled) plus `adding` must not exceed 12. */
export function seatLimitError(existing: number, adding: number): FieldErrorLike | undefined {
  if (existing + adding <= MAX_SEATS) return undefined;
  return {
    pointer: '/seats',
    code: 'seat_limit',
    message: `A team has at most ${MAX_SEATS} seats (open and filled)`,
  };
}

/**
 * Ordinals continue after the highest ordinal ever used for the role (closed seats keep theirs),
 * so `(team, role, ordinal)` stays unique.
 */
export function assignOrdinals(
  specs: readonly SeatSpec[],
  highestByRole: ReadonlyMap<string, number>,
): number[] {
  const next = new Map(highestByRole);
  return specs.map((spec) => {
    const ordinal = (next.get(spec.roleCode) ?? 0) + 1;
    next.set(spec.roleCode, ordinal);
    return ordinal;
  });
}

/**
 * Whether a team in this status refuses to change its card or seats. Finished teams keep their
 * seat marks for the reward snapshot (FR-TEAM-03); a suspended project is frozen (FR-WORK-18).
 */
export function statusBlock(status: string): ErrorCode | undefined {
  if (status === 'completed' || status === 'archived') return 'INVALID_STATE';
  if (status === 'suspended') return 'TEAM_STATUS_BLOCKS_ACTION';
  return undefined;
}

export interface SeatPatchLike {
  desired?: boolean | undefined;
  minLevel?: string | undefined;
  minHours?: number | undefined;
  stack?: string[] | undefined;
}

export interface SeatState {
  desired: boolean;
  minLevel: string;
  minHours: number;
  stack: string[];
}

export interface SeatChange {
  /** Columns to write (only those that differ from the current state). */
  set: Partial<SeatState>;
  desiredChanged: boolean;
  /** Names of changed requirements (level, hours, stack), without the desired mark. */
  requirementsChanged: string[];
}

function sameStack(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
}

/** What a seat patch really changes; a value equal to the current one is not a change. */
export function diffSeat(current: SeatState, patch: SeatPatchLike): SeatChange {
  const set: Partial<SeatState> = {};
  const requirementsChanged: string[] = [];
  let desiredChanged = false;
  if (patch.desired !== undefined && patch.desired !== current.desired) {
    set.desired = patch.desired;
    desiredChanged = true;
  }
  if (patch.minLevel !== undefined && patch.minLevel !== current.minLevel) {
    set.minLevel = patch.minLevel;
    requirementsChanged.push('minLevel');
  }
  if (patch.minHours !== undefined && patch.minHours !== current.minHours) {
    set.minHours = patch.minHours;
    requirementsChanged.push('minHours');
  }
  if (patch.stack !== undefined) {
    const stack = [...new Set(patch.stack)];
    if (!sameStack(stack, current.stack)) {
      set.stack = stack;
      requirementsChanged.push('stack');
    }
  }
  return { set, desiredChanged, requirementsChanged };
}

export interface TeamPatchLike {
  name?: string | undefined;
  description?: string | undefined;
  timezone?: string | undefined;
  hoursPerWeek?: number | undefined;
}

/** Names of the card fields a patch really changes. */
export function changedTeamFields(
  current: Required<TeamPatchLike>,
  patch: TeamPatchLike,
): string[] {
  const keys = ['name', 'description', 'timezone', 'hoursPerWeek'] as const;
  return keys.filter((key) => patch[key] !== undefined && patch[key] !== current[key]);
}
