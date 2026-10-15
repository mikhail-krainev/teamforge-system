import { Inject, Injectable } from '@nestjs/common';
import { CommittedDomainError, DomainError } from '../../../../platform/errors/domain-error.js';
import { LockService } from '../../../../platform/tx/locks.js';
import {
  LeaderVoteRepository,
  type LeaderVoteRow,
} from '../repositories/leader-vote.repository.js';

/** Locks #4 team -> #7 vote, in this order everywhere (architecture 12.1, CC-4). */
@Injectable()
export class VoteLock {
  constructor(
    @Inject(LockService) private readonly locks: LockService,
    @Inject(LeaderVoteRepository) private readonly votes: LeaderVoteRepository,
  ) {}

  /** The locked vote read after both locks; a vote of another team is "not found". */
  async lock(teamId: string, voteId: string): Promise<LeaderVoteRow> {
    if ((await this.locks.lockTeam(teamId)) === undefined) throw new DomainError('NOT_FOUND', 404);
    if ((await this.locks.lockLeaderVote(voteId)) === undefined) {
      throw new DomainError('NOT_FOUND', 404);
    }
    return this.reload(teamId, voteId);
  }

  /** The vote row again, after a step changed it; both locks are still held. */
  async reload(teamId: string, voteId: string): Promise<LeaderVoteRow> {
    const vote = await this.votes.find(teamId, voteId);
    if (vote === undefined) throw new DomainError('NOT_FOUND', 404);
    return vote;
  }
}

/**
 * What a vote operation does with a refusal: before the phase moved it is thrown at once (the
 * transaction rolls back, nothing was written); after `processDue` moved the vote it is returned,
 * to be thrown as a `CommittedDomainError` once the move is committed (CC-4 (c)).
 */
export type Refuse = (error: DomainError) => DomainError;

export function refusalAfter(moved: boolean): Refuse {
  return (error) => {
    if (!moved) throw error;
    return new CommittedDomainError(error.code, error.status);
  };
}
