import type { RoleCode, UserId } from '../profiles/public.js';

/**
 * Public surface of the matching module (ADR-0001): the only file other modules may import.
 * Contract: architecture 3.5. `DeficitPort` (teams/public.ts) is implemented inside the module
 * and bound under `DEFICIT_PORT` by `MatchingModule`.
 */
export const MATCHING_MODULE = 'matching' as const;

export type { UserId, RoleCode };
export type ApplicationId = string;
export type ApplicationStatus = 'active' | 'fulfilled' | 'cancelled';

/** One row of the demand showcase (FR-MATCH-09, FR-MATCH-11). */
export interface RoleDemand {
  roleCode: RoleCode;
  /** Teams (forming/active, fewer than 8 members) with an open seat of the role. */
  teamsSeeking: number;
  openSeats: number;
  /** People standing in the queue who asked for the role. */
  queuedCandidates: number;
  /** Mean closed wait over the last 90 days; null when there are fewer than 5 observations. */
  avgWaitSeconds: number | null;
  avgWaitStatus: 'ok' | 'insufficient_data';
  /** Open seats strictly more than the queue. */
  deficit: boolean;
  computedAt: Date;
}

/** Facade of the matching module for other modules (read-only). */
export interface MatchingApi {
  /** Demand per role, in the order asked; cached in Redis for 60 s (C-39). */
  getDemand(roles: RoleCode[]): Promise<RoleDemand[]>;
  /** True when the user stands in the queue (an `active` application exists). */
  hasActiveApplication(userId: UserId): Promise<boolean>;
}

/** Injection token of the MatchingApi implementation. */
export const MATCHING_API = Symbol('MATCHING_API');

/** Events published by matching (architecture 3.5, 4). Payloads carry identifiers only. */
export const MATCHING_EVENT_TYPES = [
  'matching.application_changed',
  'matching.auto_added',
] as const;
export type MatchingEventType = (typeof MATCHING_EVENT_TYPES)[number];

export interface ApplicationChangedPayload {
  userId: UserId;
  applicationId: ApplicationId;
  status: ApplicationStatus;
}
