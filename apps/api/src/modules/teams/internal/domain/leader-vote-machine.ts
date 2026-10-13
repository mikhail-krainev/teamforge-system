/**
 * Pure state machine of the leader vote (architecture 8.2, FR-TEAM-14..20). It decides only the
 * next phase; the services read the facts (quorum, tie, candidates left) under the locks #4 -> #7
 * and pass them in as event fields.
 */

export const VOTE_STATUSES = [
  'nominating',
  'voting',
  'runoff',
  'confirming',
  'offering',
  'closed',
  'cancelled',
] as const;
export type VoteStatus = (typeof VOTE_STATUSES)[number];

export type VoteOutcome =
  | 'elected'
  | 'appointed_senior'
  | 'sole_member'
  | 'suspended'
  | 'archived'
  | 'cancelled_lead_returned';

export type VoteTrigger = 'lead_left' | 'lead_deleted' | 'lead_inactive';

const HOUR_MS = 3_600_000;
/** C-16: nomination period. */
export const NOMINATION_MS = 24 * HOUR_MS;
/** C-18: voting period counted from the opening. */
export const VOTING_MS = 72 * HOUR_MS;
/** C-19: the single extension when there is no quorum. */
export const EXTENSION_MS = 48 * HOUR_MS;
/** C-29: runoff. */
export const RUNOFF_MS = 24 * HOUR_MS;
/** Answer to a winner confirmation or an offer to the senior member (architecture 8.2). */
export const OFFER_MS = 24 * HOUR_MS;
/** C-15: the lead is inactive after this many days. */
export const LEAD_INACTIVE_DAYS = 14;

export interface VoteState {
  status: VoteStatus;
  round: 1 | 2;
  extended: boolean;
}

export type VoteEvent =
  /** The nomination period is over. */
  | { type: 'nomination_deadline'; confirmedCandidates: number }
  /** A ballot made some candidate's count exceed N/2 (FR-TEAM-17). */
  | { type: 'majority_reached' }
  /** The voting period is over (round 1). */
  | { type: 'voting_deadline'; quorum: boolean; tie: boolean }
  /** The runoff period is over; `tie` means a second tie, settled by seniority or by lot. */
  | { type: 'runoff_deadline'; tie: boolean }
  /** The winner confirmation was declined, withdrawn or expired. */
  | { type: 'confirmation_declined'; candidatesLeft: number }
  /** The winner confirmed, or the senior member accepted. */
  | { type: 'offer_accepted' }
  /** The senior member declined or let the offer expire. */
  | { type: 'senior_declined'; membersLeft: number }
  /** The lead acted again (trigger `lead_inactive`); only before the first ballot. */
  | { type: 'lead_returned'; ballotsCast: number };

export interface VoteTransition extends VoteState {
  /** Set when the vote reaches `closed` or `cancelled`. */
  outcome: VoteOutcome | null;
  /** The runoff was decided by seniority or by lot. */
  tieBreak: boolean;
  /** The team is suspended (everybody refused the lead role, FR-TEAM-20). */
  suspendTeam: boolean;
}

interface Extra {
  round?: 1 | 2;
  extended?: boolean;
  outcome?: VoteOutcome;
  tieBreak?: boolean;
  suspendTeam?: boolean;
}

function next(state: VoteState, status: VoteStatus, extra: Extra = {}): VoteTransition {
  return {
    status,
    round: extra.round ?? state.round,
    extended: extra.extended ?? state.extended,
    outcome: extra.outcome ?? null,
    tieBreak: extra.tieBreak ?? false,
    suspendTeam: extra.suspendTeam ?? false,
  };
}

/** The next state, or `undefined` when the event is not allowed in the current phase. */
export function transition(state: VoteState, event: VoteEvent): VoteTransition | undefined {
  switch (state.status) {
    case 'nominating':
      return fromNominating(state, event);
    case 'voting':
      return fromVoting(state, event);
    case 'runoff':
      return event.type === 'runoff_deadline'
        ? next(state, 'confirming', { tieBreak: event.tie })
        : undefined;
    case 'confirming':
      return fromConfirming(state, event);
    case 'offering':
      return fromOffering(state, event);
    case 'closed':
    case 'cancelled':
      return undefined;
  }
}

function fromNominating(state: VoteState, event: VoteEvent): VoteTransition | undefined {
  if (event.type === 'nomination_deadline') {
    return next(state, event.confirmedCandidates > 0 ? 'voting' : 'offering');
  }
  if (event.type === 'lead_returned') return cancel(state, event.ballotsCast);
  return undefined;
}

function fromVoting(state: VoteState, event: VoteEvent): VoteTransition | undefined {
  switch (event.type) {
    case 'majority_reached':
      return next(state, 'confirming');
    case 'lead_returned':
      return cancel(state, event.ballotsCast);
    case 'voting_deadline':
      if (event.quorum) {
        return event.tie ? next(state, 'runoff', { round: 2 }) : next(state, 'confirming');
      }
      return state.extended ? next(state, 'offering') : next(state, 'voting', { extended: true });
    default:
      return undefined;
  }
}

function cancel(state: VoteState, ballotsCast: number): VoteTransition | undefined {
  return ballotsCast === 0
    ? next(state, 'cancelled', { outcome: 'cancelled_lead_returned' })
    : undefined;
}

function fromConfirming(state: VoteState, event: VoteEvent): VoteTransition | undefined {
  if (event.type === 'offer_accepted') return next(state, 'closed', { outcome: 'elected' });
  if (event.type === 'confirmation_declined') {
    return next(state, event.candidatesLeft > 0 ? 'confirming' : 'offering');
  }
  return undefined;
}

function fromOffering(state: VoteState, event: VoteEvent): VoteTransition | undefined {
  if (event.type === 'offer_accepted') {
    return next(state, 'closed', { outcome: 'appointed_senior' });
  }
  if (event.type === 'senior_declined') {
    return event.membersLeft > 0
      ? next(state, 'offering')
      : next(state, 'closed', { outcome: 'suspended', suspendTeam: true });
  }
  return undefined;
}

/** What opening finds right away (architecture 8.1): nobody left, one member, or a real vote. */
export type OpeningCase = 'archive' | 'sole_member' | 'open';

export function openingCase(activeMembers: number): OpeningCase {
  if (activeMembers <= 0) return 'archive';
  return activeMembers === 1 ? 'sole_member' : 'open';
}

/** Quorum = floor(N/2) + 1 of the eligible snapshot. */
export function quorumOf(eligibleCount: number): number {
  return Math.floor(eligibleCount / 2) + 1;
}

/** Requests needed for the inactivity trigger: ceil(N/2). */
export function requestsRequired(activeMembers: number): number {
  return Math.ceil(activeMembers / 2);
}

/** More than half of the eligible snapshot (FR-TEAM-17). */
export function isMajority(votes: number, eligibleCount: number): boolean {
  return votes * 2 > eligibleCount;
}

/** C-15: strictly more than 14 days without activity. */
export function leadInactive(lastActiveAt: Date | null, now: Date): boolean {
  if (lastActiveAt === null) return false;
  return now.getTime() - lastActiveAt.getTime() > LEAD_INACTIVE_DAYS * 24 * HOUR_MS;
}

/** The deadline of the phase entered at `at` (`null` when the phase has none). */
export function phaseDeadline(state: VoteState, openedAt: Date, at: Date): Date | null {
  switch (state.status) {
    case 'nominating':
      return new Date(openedAt.getTime() + NOMINATION_MS);
    case 'voting':
      return new Date(openedAt.getTime() + VOTING_MS + (state.extended ? EXTENSION_MS : 0));
    case 'runoff':
      return new Date(at.getTime() + RUNOFF_MS);
    case 'confirming':
    case 'offering':
      return new Date(at.getTime() + OFFER_MS);
    case 'closed':
    case 'cancelled':
      return null;
  }
}

export function isOpenStatus(status: string): boolean {
  return status !== 'closed' && status !== 'cancelled';
}
