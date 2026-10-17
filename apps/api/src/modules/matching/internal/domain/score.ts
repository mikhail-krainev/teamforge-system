/**
 * Pair scoring of matching (architecture 6.1, 6.2, FR-MATCH-12, ADR-0014): hard filters and the
 * weighted sum. Pure functions: no I/O, the clock comes in as an argument. A pair is an open seat
 * and a candidate; role, membership and exclusion filters (rules 1 and 5) live in `isPairAllowed`.
 */

export type Level = 'beginner' | 'junior' | 'middle';

const LEVELS: readonly Level[] = ['beginner', 'junior', 'middle'];

/** C-43: the largest difference of UTC offsets, in hours, a pair may have. */
export const MAX_TIMEZONE_DIFF_HOURS = 6;
/** C-45: the score from which the auto-add may take a pair. */
export const AUTO_ADD_THRESHOLD = 0.5;
/** FR-MATCH-12: completed projects in the role saturate at 3. */
export const COMPLETED_SATURATION = 3;

export interface ScoreWeights {
  stack: number;
  level: number;
  timezone: number;
  availability: number;
  completed: number;
}

/** C-44a..e; the sum is 1.0. */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  stack: 0.35,
  level: 0.2,
  timezone: 0.2,
  availability: 0.15,
  completed: 0.1,
};

export interface SeatFacts {
  roleCode: string;
  teamId: string;
  minLevel: Level;
  minHours: number;
  stack: readonly string[];
  teamTimezone: string;
  teamHoursPerWeek: number;
  /** Active members of the team, the lead included. */
  memberUserIds: readonly string[];
}

export interface CandidateFacts {
  userId: string;
  /** The candidate's level in the role of the seat. */
  level: Level;
  hoursPerWeek: number;
  timezone: string;
  stack: readonly string[];
  /** Completed projects in the role of the seat (`candidate_stats`). */
  completedInRole: number;
}

/** `MatchReasons` of the API contract. */
export interface MatchReasons {
  role: true;
  stack: number;
  level: number;
  timezone: number;
  availability: number;
  completedProjects: number;
  matchedStackTags: string[];
  timezoneDiffHours: number;
}

export type RejectReason = 'level' | 'hours' | 'timezone';

export type PairEvaluation =
  | { eligible: false; reason: RejectReason }
  | { eligible: true; score: number; reasons: MatchReasons };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const known = formatters.get(timeZone);
  if (known !== undefined) return known;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  formatters.set(timeZone, created);
  return created;
}

/** Offset of an IANA time zone from UTC in hours at `at` (daylight saving included); null if unknown. */
export function utcOffsetHours(timeZone: string, at: Date): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatterFor(timeZone).formatToParts(at);
  } catch {
    return null;
  }
  const field: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of parts) field[part.type] = part.value;
  const local = Date.UTC(
    Number(field.year),
    Number(field.month) - 1,
    Number(field.day),
    Number(field.hour),
    Number(field.minute),
    Number(field.second),
  );
  const instant = Math.floor(at.getTime() / 1000) * 1000;
  return (local - instant) / 3_600_000;
}

/** Steps of `level` above `base` (negative: below). */
export function levelSteps(level: Level, base: Level): number {
  return LEVELS.indexOf(level) - LEVELS.indexOf(base);
}

/** 1.0 at the seat minimum, 0.75 one step above, 0.5 two steps above; 0 below the minimum. */
export function levelScore(level: Level, minLevel: Level): number {
  const steps = levelSteps(level, minLevel);
  return steps < 0 ? 0 : 1 - steps * 0.25;
}

/** Share of the seat stack the candidate has; 1.0 when the seat names no stack. */
export function stackScore(
  seatStack: readonly string[],
  candidateStack: readonly string[],
): { score: number; matched: string[] } {
  if (seatStack.length === 0) return { score: 1, matched: [] };
  const have = new Set(candidateStack);
  const matched = [...new Set(seatStack)].filter((tag) => have.has(tag)).sort();
  return { score: matched.length / new Set(seatStack).size, matched };
}

export function timezoneScore(diffHours: number): number {
  return Math.max(0, 1 - Math.abs(diffHours) / MAX_TIMEZONE_DIFF_HOURS);
}

export function availabilityScore(
  hoursPerWeek: number,
  minHours: number,
  teamHoursPerWeek: number,
): number {
  const needed = Math.max(minHours, teamHoursPerWeek);
  return needed <= 0 ? 1 : Math.min(1, hoursPerWeek / needed);
}

export function completedScore(completedInRole: number): number {
  return Math.min(Math.max(completedInRole, 0), COMPLETED_SATURATION) / COMPLETED_SATURATION;
}

/** Three decimals: the precision of `match_candidate.score`. */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Hard filters 2 to 4 and the weighted score of one pair. The same inputs always give the same
 * result (the clock is the `now` argument, used for the time zone offsets).
 */
export function evaluatePair(
  seat: SeatFacts,
  candidate: CandidateFacts,
  now: Date,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): PairEvaluation {
  if (levelSteps(candidate.level, seat.minLevel) < 0) return { eligible: false, reason: 'level' };
  if (candidate.hoursPerWeek < seat.minHours) return { eligible: false, reason: 'hours' };
  const candidateOffset = utcOffsetHours(candidate.timezone, now);
  const teamOffset = utcOffsetHours(seat.teamTimezone, now);
  if (candidateOffset === null || teamOffset === null)
    return { eligible: false, reason: 'timezone' };
  const diff = Math.abs(candidateOffset - teamOffset);
  if (diff > MAX_TIMEZONE_DIFF_HOURS) return { eligible: false, reason: 'timezone' };

  const stack = stackScore(seat.stack, candidate.stack);
  const level = levelScore(candidate.level, seat.minLevel);
  const timezone = timezoneScore(diff);
  const availability = availabilityScore(
    candidate.hoursPerWeek,
    seat.minHours,
    seat.teamHoursPerWeek,
  );
  const completed = completedScore(candidate.completedInRole);
  const raw =
    weights.stack * stack.score +
    weights.level * level +
    weights.timezone * timezone +
    weights.availability * availability +
    weights.completed * completed;
  return {
    eligible: true,
    score: Math.min(1, Math.max(0, round3(raw))),
    reasons: {
      role: true,
      stack: round4(stack.score),
      level: round4(level),
      timezone: round4(timezone),
      availability: round4(availability),
      completedProjects: round4(completed),
      matchedStackTags: stack.matched,
      timezoneDiffHours: round4(diff),
    },
  };
}

/**
 * Hard filter 5: the candidate is neither a member nor the lead of the seat's team, and the team
 * did not exclude the candidate from the trial period (FR-MATCH-08).
 */
export function isPairAllowed(
  seat: Pick<SeatFacts, 'teamId' | 'memberUserIds'>,
  userId: string,
  excludedTeamIds: ReadonlySet<string>,
): boolean {
  return !seat.memberUserIds.includes(userId) && !excludedTeamIds.has(seat.teamId);
}

/** Order of recommendations: score descending, then user id (the index order of `match_candidate`). */
export function compareRecommendations(
  a: { score: number; userId: string },
  b: { score: number; userId: string },
): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

/** The level of a candidate in a role: the profile's, `beginner` for a queued role without one. */
export function levelInRole(
  rolePrefs: readonly { roleCode: string; level: Level }[],
  roleCode: string,
): Level {
  return rolePrefs.find((pref) => pref.roleCode === roleCode)?.level ?? 'beginner';
}
