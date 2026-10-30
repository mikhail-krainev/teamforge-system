/**
 * Public surface of the rewards module (ADR-0001): the only file other modules may import.
 * Contract: architecture 3.8. The module reads no review (FR-REW-13) and no other module reads its tables.
 */
export const REWARDS_MODULE = 'rewards' as const;

export type UserId = string;
export type TeamId = string;

/** A badge of a person as the profile shows it (revoked ones are not returned). */
export interface AwardView {
  badgeCode: string;
  name: string;
  series: 'projects' | 'roles' | 'product_types' | null;
  step: number | null;
  teamId: TeamId | null;
  teamName: string | null;
  awardedAt: Date;
}

export interface CounterView {
  total: number;
  byRole: { roleCode: string; value: number }[];
  productTypes: string[];
}

export type CreditRunStatus = 'cooling' | 'frozen' | 'credited' | 'revoked';
export type CreditItemStatus = 'credited' | 'pending_account' | 'revoked' | 'denied';

/** What a participant may know about the credit of a project: his own credits and the state of the run, nothing else. */
export interface CreditStatusView {
  teamId: TeamId;
  status: CreditRunStatus;
  coolingUntil: Date;
  myCredits: { roleCode: string; status: CreditItemStatus; reason: string | null }[];
}

export interface RewardsApi {
  getUserAwards(userId: UserId): Promise<AwardView[]>;
  getCounters(userId: UserId): Promise<CounterView>;
  /** `null` for a project without a credit run and for a person who is no participant of it. */
  getCreditStatus(teamId: TeamId, userId: UserId): Promise<CreditStatusView | null>;
}

export const REWARDS_API = Symbol('REWARDS_API');

/** Events published by rewards (architecture 3.8); payloads hold ids and numbers only. */
export const REWARDS_EVENT_TYPES = [
  'rewards.credits_changed',
  'rewards.award_granted',
  'rewards.award_revoked',
  'rewards.case_opened',
] as const;
export type RewardsEventType = (typeof REWARDS_EVENT_TYPES)[number];

/**
 * Payload of `rewards.credits_changed` (version 1): `counters` is `{ [roleCode]: completed projects }` after the
 * change, a role that fell to zero stays in it as 0 (matching replaces the stored number); `total` is the
 * total counter.
 */
export interface CreditsChangedPayload {
  v: 1;
  userId: UserId;
  roleCodes: string[];
  counters: Record<string, number>;
  total: number;
}
