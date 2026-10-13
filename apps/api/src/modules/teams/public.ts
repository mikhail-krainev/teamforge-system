import type { PlaybookId, ProductTypeCode } from '../playbooks/public.js';
import type { Level, RoleCode, UserId } from '../profiles/public.js';

/**
 * Public surface of the teams module (ADR-0001): the only file other modules may import.
 * Contract: architecture 3.4.
 */
export const TEAMS_MODULE = 'teams' as const;

export type { UserId, RoleCode, Level, PlaybookId, ProductTypeCode };
export type TeamId = string;
export type SeatId = string;
export type ApplicationId = string;

export type TeamStatus = 'forming' | 'active' | 'voting' | 'suspended' | 'completed' | 'archived';
export type JoinVia = 'invite' | 'offer' | 'request' | 'auto';

export type JoinRejectCode =
  | 'SEAT_TAKEN'
  | 'SEAT_NOT_OPEN'
  | 'TEAM_FULL'
  | 'PROJECT_LIMIT'
  | 'ROLE_LIMIT'
  | 'ALREADY_MEMBER'
  | 'GITHUB_REQUIRED'
  | 'CONSENT_REQUIRED'
  | 'INVALID_STATE'
  | 'USER_INACTIVE';

export interface Rejection<C extends string> {
  ok: false;
  code: C;
}

/**
 * `userLocked` is not a trust flag and never skips checks: `true` means the caller already took
 * lock #1 (user) for exactly this `userId` in the current transaction (architecture 3.4).
 */
export interface JoinSeatInput {
  seatId: SeatId;
  userId: UserId;
  via: JoinVia;
  applicationId?: ApplicationId;
  userLocked: boolean;
}

export type JoinSeatResult =
  | {
      ok: true;
      teamId: TeamId;
      seatId: SeatId;
      roleCode: RoleCode;
      membershipId: string;
      trialUntil: Date | null;
      deficitAtJoin: boolean;
    }
  | Rejection<JoinRejectCode>;

export interface TeamLockView {
  teamId: TeamId;
  status: TeamStatus;
  leadUserId: UserId | null;
  memberCount: number;
  startedAt: Date | null;
  plannedEndAt: Date | null;
  playbookId: PlaybookId;
  productType: ProductTypeCode;
}

export interface RosterMember {
  userId: UserId;
  joinedAt: Date;
  joinedVia: string;
  trialUntil: Date | null;
  isLead: boolean;
  roles: { roleCode: RoleCode; assignedAt: Date; deficitAtJoin: boolean }[];
}

export interface RosterSnapshot {
  members: RosterMember[];
  seats: {
    seatId: SeatId;
    roleCode: RoleCode;
    desired: boolean;
    desiredChangedAt: Date | null;
    holderUserId: UserId | null;
  }[];
  departedUserIds: UserId[];
}

/**
 * Facade of the teams module. Slice 3 provides the members of this list; the catalog reads
 * `listOpenSeats` / `countOpenSeatsByRole` belong to slice 4 (matching) and are added there.
 * Methods marked `@requiresTx` throw outside a transaction.
 */
export interface TeamsApi {
  getTeamView(teamId: TeamId): Promise<TeamLockView | null>;
  /** Active members only. */
  getRoster(teamId: TeamId): Promise<RosterMember[]>;
  /** Throws 403 NOT_TEAM_MEMBER. */
  assertMember(teamId: TeamId, userId: UserId): Promise<void>;
  /** Throws 403 NOT_TEAM_LEAD. */
  assertLead(teamId: TeamId, userId: UserId): Promise<void>;
  /**
   * @requiresTx. Lock order: [user, application held by the caller], team, seat. Never throws
   * domain errors: refusals come back as `{ ok: false, code }`. Implemented in S3-04.
   */
  joinSeat(input: JoinSeatInput): Promise<JoinSeatResult>;
  /**
   * @requiresTx. Lock #4: `FOR NO KEY UPDATE` ('update', default) or `FOR SHARE` ('share', for
   * operations that only need the status to stay unchanged). Throws 404 when the team is missing.
   */
  lockTeam(teamId: TeamId, mode?: 'update' | 'share'): Promise<TeamLockView>;
  /** @requiresTx, the team must be locked by the caller. Stub until slice 6. */
  getCompletionRosterSnapshot(teamId: TeamId): Promise<RosterSnapshot>;
  /** @requiresTx */
  markCompleted(teamId: TeamId, completedAt: Date): Promise<void>;
  /** @requiresTx */
  setReleaseUrl(teamId: TeamId, url: string): Promise<void>;
}

/** Ports declared by teams, implemented by upper modules and bound in AppModule. */

/** Implemented by matching (FR-MATCH-11); stubbed until slice 4. */
export interface DeficitPort {
  evaluate(input: {
    roleCode: RoleCode;
    openSeats: number;
    joiningUserId: UserId;
    via: JoinVia;
  }): Promise<{ deficit: boolean; openSeats: number; queued: number }>;
}

/** Implemented by workspace (FR-WORK-01); stubbed until slice 5. */
export interface TeamLifecyclePort {
  onProjectStarted(input: {
    teamId: TeamId;
    playbookId: PlaybookId;
    startedAt: Date;
  }): Promise<void>;
}

export const TEAMS_API = Symbol('TEAMS_API');
export const DEFICIT_PORT = Symbol('DEFICIT_PORT');
export const TEAM_LIFECYCLE_PORT = Symbol('TEAM_LIFECYCLE_PORT');

/** Events published by teams (architecture 3.4); payload types grow with the services. */
export const TEAM_EVENT_TYPES = [
  'teams.team_created',
  'teams.team_started',
  'teams.team_status_changed',
  'teams.seat_opened',
  'teams.seat_closed',
  'teams.seat_desired_changed',
  'teams.member_joined',
  'teams.member_left',
  'teams.member_excluded',
  'teams.lead_changed',
  'teams.vote_updated',
  'teams.offer_created',
] as const;
export type TeamEventType = (typeof TEAM_EVENT_TYPES)[number];
