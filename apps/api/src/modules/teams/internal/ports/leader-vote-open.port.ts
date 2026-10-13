import { Injectable } from '@nestjs/common';

/** Why a leader vote is being opened on a departure of the lead (FR-TEAM-14). */
export interface LeaderVoteOpenInput {
  teamId: string;
  /** The lead who has just left; already removed from the roster by the caller. */
  leaderUserId: string;
  trigger: 'lead_left' | 'lead_deleted';
  at: Date;
}

/**
 * Opens the leader vote. Declared here, implemented by the vote services of S3-07, so that
 * `leaveTeam` (S3-06) does not depend on them. Called in the transaction of the leave, with the
 * team locked (#4) and the leaver already removed from the roster.
 */
export interface LeaderVoteOpenPort {
  open(input: LeaderVoteOpenInput): Promise<void>;
}

export const LEADER_VOTE_OPEN_PORT = Symbol('LEADER_VOTE_OPEN_PORT');

/** Binding of S3-06: opens nothing. Kept for unit tests; the module binds `VoteOpenService`. */
@Injectable()
export class StubLeaderVoteOpenPort implements LeaderVoteOpenPort {
  open(): Promise<void> {
    return Promise.resolve();
  }
}
