import type { RoleCode, UserId } from '../profiles/public.js';

/**
 * Public surface of the matching module (ADR-0001): the only file other modules may import.
 * Contract: architecture 3.5. The demand showcase (`getDemand`) and the `DeficitPort`
 * implementation join this surface in S4-03.
 */
export const MATCHING_MODULE = 'matching' as const;

export type { UserId, RoleCode };
export type ApplicationId = string;
export type ApplicationStatus = 'active' | 'fulfilled' | 'cancelled';

/** Facade of the matching module for other modules (read-only). */
export interface MatchingApi {
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
