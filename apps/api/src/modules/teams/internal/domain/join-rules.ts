import type { JoinRejectCode } from '../../public.js';
import { MAX_ACTIVE_PROJECTS, MAX_MEMBERS } from './team-rules.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** C-12: lifetime of an offer or a request. */
export const OFFER_TTL_MS = 7 * DAY_MS;
/** C-11: trial period of an automatically added member. */
export const TRIAL_MS = 7 * DAY_MS;
/** C-03: different roles one member holds in a team. */
export const MAX_ROLES_PER_MEMBER = 2;
/** FR-TEAM-28: pending offers of the lead per team. */
export const MAX_PENDING_OFFERS_PER_TEAM = 30;
/** FR-TEAM-29: pending requests of one candidate over all teams. */
export const MAX_PENDING_REQUESTS_PER_USER = 10;
/** Team statuses that accept new members (FR-TEAM-28, FR-TEAM-29). */
export const JOINABLE_STATUSES: readonly string[] = ['forming', 'active'];

/** What is known about a join once team and seat are locked (architecture CC-1, CC-2). */
export interface JoinFacts {
  teamStatus: string;
  memberCount: number;
  seatStatus: string;
  seatRole: string;
  /** The user already has an active membership in this team. */
  isMember: boolean;
  /** Roles the user currently holds in this team (empty for a non-member). */
  heldRoles: readonly string[];
  /** Active projects of the user (FR-TEAM-05), counted under lock #1. */
  activeProjects: number;
}

/** First refusal in the order the contract lists them, or `undefined` when the join is allowed. */
export function joinRefusal(facts: JoinFacts): JoinRejectCode | undefined {
  if (!JOINABLE_STATUSES.includes(facts.teamStatus)) return 'INVALID_STATE';
  if (facts.seatStatus === 'filled') return 'SEAT_TAKEN';
  if (facts.seatStatus !== 'open') return 'SEAT_NOT_OPEN';
  if (facts.isMember) return secondRoleRefusal(facts);
  if (facts.activeProjects >= MAX_ACTIVE_PROJECTS) return 'PROJECT_LIMIT';
  if (facts.memberCount >= MAX_MEMBERS) return 'TEAM_FULL';
  return undefined;
}

/** FR-TEAM-07: a second role of another kind; the project and the member count do not change. */
function secondRoleRefusal(facts: JoinFacts): JoinRejectCode | undefined {
  if (facts.heldRoles.includes(facts.seatRole)) return 'ALREADY_MEMBER';
  if (facts.heldRoles.length >= MAX_ROLES_PER_MEMBER) return 'ROLE_LIMIT';
  return undefined;
}

/** Joins that need an HTTP answer other than 409. */
export function joinRefusalStatus(code: JoinRejectCode): number {
  return code === 'CONSENT_REQUIRED' ? 403 : 409;
}

/** Refusals after which the offer is dead for good (the seat changed under it). */
export function cancelsOffer(code: JoinRejectCode): boolean {
  return code === 'SEAT_TAKEN' || code === 'SEAT_NOT_OPEN';
}
