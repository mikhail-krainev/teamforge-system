import type { RoleDemand } from '../../public.js';

/** C-39: how long a computed showcase row lives in Redis. */
export const DEMAND_CACHE_TTL_SECONDS = 60;
/** C-41: closed waits older than this do not count in the average. */
export const WAIT_WINDOW_DAYS = 90;
/** C-42: fewer closed waits than this give no number. */
export const WAIT_MIN_SAMPLES = 5;
/** Most roles one showcase request may ask for (contract: `maxItems: 20`). */
export const DEMAND_MAX_ROLES = 20;

/** FR-MATCH-11: a role is a deficit when the open seats are strictly more than the people queued. */
export function isDeficit(openSeats: number, queued: number): boolean {
  return openSeats > queued;
}

export interface WaitStats {
  samples: number;
  avgSeconds: number | null;
}

/** C-42: the average is shown only when there are enough observations. */
export function waitView(
  stats: WaitStats | undefined,
): Pick<RoleDemand, 'avgWaitSeconds' | 'avgWaitStatus'> {
  if (stats === undefined || stats.samples < WAIT_MIN_SAMPLES || stats.avgSeconds === null) {
    return { avgWaitSeconds: null, avgWaitStatus: 'insufficient_data' };
  }
  return { avgWaitSeconds: Math.round(stats.avgSeconds), avgWaitStatus: 'ok' };
}

export interface RoleFacts {
  openSeats: number;
  teamsSeeking: number;
  queued: number;
  wait: WaitStats | undefined;
}

export function buildRoleDemand(roleCode: string, facts: RoleFacts, computedAt: Date): RoleDemand {
  return {
    roleCode,
    teamsSeeking: facts.teamsSeeking,
    openSeats: facts.openSeats,
    queuedCandidates: facts.queued,
    ...waitView(facts.wait),
    deficit: isDeficit(facts.openSeats, facts.queued),
    computedAt,
  };
}

/** Requested role keys without repeats, in the order asked. */
export function uniqueRoles(roles: readonly string[]): string[] {
  return [...new Set(roles)];
}
