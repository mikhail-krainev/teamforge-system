import { Inject, Injectable } from '@nestjs/common';
import type { Body } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { JoinRepository } from '../repositories/join.repository.js';
import {
  LeaderVoteRepository,
  type LeaderVoteRow,
} from '../repositories/leader-vote.repository.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import { type LeaderVoteDto } from './vote-dto.js';
import { VoteFlowService } from './vote-flow.service.js';
import { VoteLock, refusalAfter, type Refuse } from './vote-lock.js';
import { VoteQueryService } from './vote-query.service.js';
import { journalRow, teamsEvent } from './team-events.js';

/** Phases in which a candidacy can be withdrawn; in `confirming` it counts as declining the offer. */
const WITHDRAW_PHASES = ['nominating', 'voting', 'runoff', 'confirming'];

/** The vote under its locks, with the phase brought up to date (CC-4 (c)) and how to refuse. */
interface Settled {
  vote: LeaderVoteRow;
  refuse: Refuse;
}

/**
 * nominateCandidate, consentCandidacy, withdrawCandidacy (FR-TEAM-15, -16).
 * Locks: #4 team -> #7 vote. A phase whose time is over is closed first; whoever acts, and whoever
 * is nominated, must still be on the roster (a leaver keeps neither the right nor the candidacy).
 */
@Injectable()
export class VoteNominateService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(VoteLock) private readonly lock: VoteLock,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(JoinRepository) private readonly joins: JoinRepository,
    @Inject(LeaderVoteRepository) private readonly votes: LeaderVoteRepository,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
    @Inject(VoteQueryService) private readonly query: VoteQueryService,
    @Inject(VoteFlowService) private readonly flow: VoteFlowService,
  ) {}

  async nominate(
    userId: string,
    teamId: string,
    voteId: string,
    body: Body<'nominateCandidate'>,
  ): Promise<LeaderVoteDto> {
    const refused = await this.tx.run(async () => {
      const now = this.clock.now();
      const { vote, refuse } = await this.settle(teamId, voteId, now);
      if (vote.status !== 'nominating') return refuse(new DomainError('VOTE_PHASE', 409));
      const eligible = new Set((await this.votes.eligibleOf(voteId)).map((e) => e.userId));
      if (
        !eligible.has(userId) ||
        !eligible.has(body.userId) ||
        !(await this.isActive(teamId, userId)) ||
        !(await this.isActive(teamId, body.userId))
      ) {
        return refuse(new DomainError('NOT_ELIGIBLE', 403));
      }
      if ((await this.votes.findCandidate(voteId, body.userId)) !== undefined) {
        return refuse(new DomainError('CANDIDATE_EXISTS', 409));
      }
      await this.votes.insertCandidate({ voteId, userId: body.userId, nominatedBy: userId });
      await this.record(vote, 'candidate_nominated', userId, { candidateUserId: body.userId }, now);
      return undefined;
    });
    if (refused !== undefined) throw refused;
    return this.query.get(userId, teamId, voteId);
  }

  async consent(
    userId: string,
    teamId: string,
    voteId: string,
    candidateUserId: string,
  ): Promise<LeaderVoteDto> {
    const refused = await this.tx.run(async () => {
      if (candidateUserId !== userId) throw new DomainError('NOT_FOUND', 404);
      const now = this.clock.now();
      const { vote, refuse } = await this.settle(teamId, voteId, now);
      const candidate = await this.votes.findCandidate(voteId, userId);
      if (candidate === undefined) return refuse(new DomainError('NOT_FOUND', 404));
      if (vote.status !== 'nominating') return refuse(new DomainError('VOTE_PHASE', 409));
      if (candidate.withdrawnAt !== null) return refuse(new DomainError('INVALID_STATE', 409));
      if (!(await this.isActive(teamId, userId))) {
        return refuse(new DomainError('NOT_ELIGIBLE', 403));
      }
      if (candidate.consentAt !== null) return undefined;
      await this.votes.updateCandidate(voteId, userId, { consentAt: now });
      await this.record(vote, 'candidacy_confirmed', userId, { candidateUserId: userId }, now);
      return undefined;
    });
    if (refused !== undefined) throw refused;
    return this.query.get(userId, teamId, voteId);
  }

  async withdraw(userId: string, teamId: string, voteId: string): Promise<LeaderVoteDto> {
    const refused = await this.tx.run(async () => {
      const now = this.clock.now();
      const { vote, refuse } = await this.settle(teamId, voteId, now);
      const candidate = await this.votes.findCandidate(voteId, userId);
      if (candidate === undefined) return refuse(new DomainError('NOT_FOUND', 404));
      if (!WITHDRAW_PHASES.includes(vote.status)) {
        return refuse(new DomainError('VOTE_PHASE', 409));
      }
      if (candidate.withdrawnAt !== null) return refuse(new DomainError('INVALID_STATE', 409));
      if (!(await this.isActive(teamId, userId))) {
        return refuse(new DomainError('NOT_ELIGIBLE', 403));
      }
      await this.votes.updateCandidate(voteId, userId, { withdrawnAt: now });
      await this.record(vote, 'candidacy_withdrawn', userId, { candidateUserId: userId }, now);
      if (vote.status === 'confirming') await this.declinePendingOffer(vote, userId, now);
      return undefined;
    });
    if (refused !== undefined) throw refused;
    return this.query.get(userId, teamId, voteId);
  }

  /** Withdrawing the winner who is being asked equals declining: the next one by votes is asked (8.2). */
  private async declinePendingOffer(vote: LeaderVoteRow, userId: string, now: Date): Promise<void> {
    const offer = await this.votes.pendingOffer(vote.id);
    if (offer?.userId !== userId) return;
    await this.flow.answer(vote, offer, 'declined', now);
  }

  /** #4 team, then #7 vote (a vote of another team is "not found"), then the phase up to date. */
  private async settle(teamId: string, voteId: string, now: Date): Promise<Settled> {
    let vote = await this.lock.lock(teamId, voteId);
    const moved = await this.flow.processDue(vote, now);
    if (moved) vote = await this.lock.reload(teamId, voteId);
    return { vote, refuse: refusalAfter(moved) };
  }

  private async isActive(teamId: string, userId: string): Promise<boolean> {
    return (await this.joins.activeMembership(teamId, userId)) !== undefined;
  }

  private async record(
    vote: LeaderVoteRow,
    type: 'candidate_nominated' | 'candidacy_confirmed' | 'candidacy_withdrawn',
    actor: string,
    payload: Record<string, unknown>,
    now: Date,
  ): Promise<void> {
    await this.events.insertMany([
      journalRow(vote.teamId, type, actor, { voteId: vote.id, ...payload }, now),
    ]);
    await this.outbox.publish(
      teamsEvent('vote_updated', vote.teamId, {
        teamId: vote.teamId,
        voteId: vote.id,
        status: vote.status,
        round: vote.round,
      }),
    );
  }
}
