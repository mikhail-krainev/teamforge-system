import { Inject, Injectable } from '@nestjs/common';
import type { Body } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { JoinRepository } from '../repositories/join.repository.js';
import { LeaderVoteRepository } from '../repositories/leader-vote.repository.js';
import type { LeaderVoteDto } from './vote-dto.js';
import { VoteFlowService, onBallot } from './vote-flow.service.js';
import { VoteLock, refusalAfter } from './vote-lock.js';
import { VoteQueryService } from './vote-query.service.js';

/**
 * castBallot (FR-TEAM-16, -17, -19). Locks #4 team -> #7 vote; `vote_ballot_pkey` (vote, round,
 * voter) is the last line of defence for "one ballot per person and round" (CC-4 (a)). Nobody
 * reads who voted for whom: the tally only counts.
 */
@Injectable()
export class VoteBallotService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(VoteLock) private readonly lock: VoteLock,
    @Inject(JoinRepository) private readonly joins: JoinRepository,
    @Inject(LeaderVoteRepository) private readonly votes: LeaderVoteRepository,
    @Inject(VoteFlowService) private readonly flow: VoteFlowService,
    @Inject(VoteQueryService) private readonly query: VoteQueryService,
  ) {}

  async cast(
    userId: string,
    teamId: string,
    voteId: string,
    body: Body<'castBallot'>,
  ): Promise<LeaderVoteDto> {
    const refused = await this.tx.run(async (): Promise<DomainError | undefined> => {
      const now = this.clock.now();
      let vote = await this.lock.lock(teamId, voteId);
      // A phase whose time is over is closed before the ballot is looked at (CC-4 (c)).
      const moved = await this.flow.processDue(vote, now);
      if (moved) vote = await this.lock.reload(teamId, voteId);
      // After the phase moved, a refusal must not roll the move back: it is answered after the commit.
      const refuse = refusalAfter(moved);
      if (vote.status !== 'voting' && vote.status !== 'runoff') {
        return refuse(new DomainError('VOTE_PHASE', 409));
      }
      if (!(await this.isVoter(teamId, voteId, userId))) {
        return refuse(new DomainError('NOT_ELIGIBLE', 403));
      }
      const candidate = (await this.votes.candidatesOf(voteId)).find(
        (c) => c.userId === body.candidateUserId,
      );
      if (candidate?.withdrawnAt) return refuse(new DomainError('INVALID_STATE', 409));
      if (
        candidate === undefined ||
        !onBallot(candidate) ||
        (vote.status === 'runoff' && !candidate.inRunoff)
      ) {
        return refuse(new DomainError('NOT_FOUND', 404));
      }
      if (await this.votes.hasBallot(voteId, vote.round, userId)) {
        return refuse(new DomainError('ALREADY_VOTED', 409));
      }
      await this.votes.insertBallot({
        voteId,
        round: vote.round,
        voterUserId: userId,
        candidateUserId: candidate.userId,
        castAt: now,
      });
      await this.flow.afterBallot(vote, now);
      return undefined;
    });
    if (refused !== undefined) throw refused;
    return this.query.get(userId, teamId, voteId);
  }

  /** Right to vote: in the snapshot and still on the roster (a leaver keeps his ballot, not his right). */
  private async isVoter(teamId: string, voteId: string, userId: string): Promise<boolean> {
    const eligible = (await this.votes.eligibleOf(voteId)).some((e) => e.userId === userId);
    const active = (await this.joins.activeMembership(teamId, userId)) !== undefined;
    return eligible && active;
  }
}
