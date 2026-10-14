import { Inject, Injectable } from '@nestjs/common';
import type { Body } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { CommittedDomainError, DomainError } from '../../../../platform/errors/domain-error.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { JoinRepository } from '../repositories/join.repository.js';
import { LeaderVoteRepository } from '../repositories/leader-vote.repository.js';
import type { LeaderVoteDto } from './vote-dto.js';
import { VoteFlowService } from './vote-flow.service.js';
import { VoteLock } from './vote-lock.js';
import { VoteQueryService } from './vote-query.service.js';

/**
 * respondLeaderOffer (FR-TEAM-17, -18, -20): the winner confirms or declines, or the longest-serving
 * member accepts or declines the lead role. Locks #4 team -> #7 vote, then the pending `vote_offer`.
 */
@Injectable()
export class VoteOfferService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(VoteLock) private readonly lock: VoteLock,
    @Inject(JoinRepository) private readonly joins: JoinRepository,
    @Inject(LeaderVoteRepository) private readonly votes: LeaderVoteRepository,
    @Inject(VoteFlowService) private readonly flow: VoteFlowService,
    @Inject(VoteQueryService) private readonly query: VoteQueryService,
  ) {}

  async respond(
    userId: string,
    teamId: string,
    voteId: string,
    body: Body<'respondLeaderOffer'>,
  ): Promise<LeaderVoteDto> {
    const lapsed = await this.tx.run(async () => {
      const vote = await this.lock.lock(teamId, voteId);
      if (vote.status !== 'confirming' && vote.status !== 'offering') {
        throw new DomainError('VOTE_PHASE', 409);
      }
      const offer = await this.votes.pendingOffer(voteId);
      if (offer === undefined) throw new DomainError('VOTE_PHASE', 409);
      if (offer.userId !== userId) throw new DomainError('NOT_ELIGIBLE', 403);
      const now = this.clock.now();
      if (offer.expiresAt.getTime() <= now.getTime()) {
        // The time for the answer is over: the offer passes on, and the late answer is refused.
        await this.flow.answer(vote, offer, 'expired', now);
        return true;
      }
      if (body.accept && (await this.joins.activeMembership(teamId, userId)) === undefined) {
        throw new DomainError('NOT_ELIGIBLE', 403);
      }
      await this.flow.answer(vote, offer, body.accept ? 'accepted' : 'declined', now);
      return false;
    });
    if (lapsed) throw new CommittedDomainError('VOTE_PHASE', 409);
    return this.query.get(userId, teamId, voteId);
  }
}
