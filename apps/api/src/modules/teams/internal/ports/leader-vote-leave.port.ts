import { Injectable } from '@nestjs/common';

/** A member has left the roster (FR-TEAM-11, -14). */
export interface LeaderVoteLeaveInput {
  teamId: string;
  userId: string;
  /** Active members after the leave. */
  remaining: number;
  /** The leaver was the lead; the vote for his place is opened through `LeaderVoteOpenPort`. */
  wasLead: boolean;
  at: Date;
}

export interface LeaderVoteLeaveResult {
  /** The team is archived because nobody is left (an open vote is closed with it). */
  archived: boolean;
}

/**
 * What a departure does to the leader vote and to an empty team. Called in the transaction of the
 * leave, after the locks #4 -> #5 -> #6 and the removal from the roster; it takes lock #7 itself.
 */
export interface LeaderVoteLeavePort {
  afterLeave(input: LeaderVoteLeaveInput): Promise<LeaderVoteLeaveResult>;
}

export const LEADER_VOTE_LEAVE_PORT = Symbol('LEADER_VOTE_LEAVE_PORT');

/** Binding for unit tests: touches nothing. The module binds `VoteLeaveService`. */
@Injectable()
export class StubLeaderVoteLeavePort implements LeaderVoteLeavePort {
  afterLeave(): Promise<LeaderVoteLeaveResult> {
    return Promise.resolve({ archived: false });
  }
}
