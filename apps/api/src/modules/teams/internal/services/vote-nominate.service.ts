import { Inject, Injectable } from '@nestjs/common';
import type { Body } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import {
  LeaderVoteRepository,
  type LeaderVoteRow,
} from '../repositories/leader-vote.repository.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import { type LeaderVoteDto } from './vote-dto.js';
import { VoteQueryService } from './vote-query.service.js';
import { journalRow, teamsEvent } from './team-events.js';

interface RawVote {
  id: string;
  team_id: string;
  status: string;
}

/** Phases in which a candidacy can be withdrawn here; `confirming` belongs to the offer flow (S3-08). */
const WITHDRAW_PHASES = ['nominating', 'voting', 'runoff'];

/**
 * nominateCandidate, consentCandidacy, withdrawCandidacy (FR-TEAM-15, -16).
 * Locks: #4 team -> #7 vote.
 */
@Injectable()
export class VoteNominateService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(LeaderVoteRepository) private readonly votes: LeaderVoteRepository,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
    @Inject(VoteQueryService) private readonly query: VoteQueryService,
  ) {}

  async nominate(
    userId: string,
    teamId: string,
    voteId: string,
    body: Body<'nominateCandidate'>,
  ): Promise<LeaderVoteDto> {
    await this.tx.run(async () => {
      const vote = await this.lockVote(teamId, voteId);
      this.requirePhase(vote, ['nominating']);
      const eligible = new Set((await this.votes.eligibleOf(voteId)).map((e) => e.userId));
      if (!eligible.has(userId) || !eligible.has(body.userId)) {
        throw new DomainError('NOT_ELIGIBLE', 403);
      }
      if ((await this.votes.findCandidate(voteId, body.userId)) !== undefined) {
        throw new DomainError('CANDIDATE_EXISTS', 409);
      }
      const now = this.clock.now();
      await this.votes.insertCandidate({
        voteId,
        userId: body.userId,
        nominatedBy: userId,
      });
      await this.record(vote, 'candidate_nominated', userId, { candidateUserId: body.userId }, now);
    });
    return this.query.get(userId, teamId, voteId);
  }

  async consent(
    userId: string,
    teamId: string,
    voteId: string,
    candidateUserId: string,
  ): Promise<LeaderVoteDto> {
    await this.tx.run(async () => {
      if (candidateUserId !== userId) throw new DomainError('NOT_FOUND', 404);
      const vote = await this.lockVote(teamId, voteId);
      const candidate = await this.votes.findCandidate(voteId, userId);
      if (candidate === undefined) throw new DomainError('NOT_FOUND', 404);
      this.requirePhase(vote, ['nominating']);
      if (candidate.withdrawnAt !== null) throw new DomainError('INVALID_STATE', 409);
      if (candidate.consentAt !== null) return;
      const now = this.clock.now();
      await this.votes.updateCandidate(voteId, userId, { consentAt: now });
      await this.record(vote, 'candidacy_confirmed', userId, { candidateUserId: userId }, now);
    });
    return this.query.get(userId, teamId, voteId);
  }

  async withdraw(userId: string, teamId: string, voteId: string): Promise<LeaderVoteDto> {
    await this.tx.run(async () => {
      const vote = await this.lockVote(teamId, voteId);
      const candidate = await this.votes.findCandidate(voteId, userId);
      if (candidate === undefined) throw new DomainError('NOT_FOUND', 404);
      this.requirePhase(vote, WITHDRAW_PHASES);
      if (candidate.withdrawnAt !== null) throw new DomainError('INVALID_STATE', 409);
      const now = this.clock.now();
      await this.votes.updateCandidate(voteId, userId, { withdrawnAt: now });
      await this.record(vote, 'candidacy_withdrawn', userId, { candidateUserId: userId }, now);
    });
    return this.query.get(userId, teamId, voteId);
  }

  /** #4 team, then #7 vote; a vote of another team is "not found". */
  private async lockVote(teamId: string, voteId: string): Promise<RawVote> {
    const team = await this.locks.lockTeam(teamId);
    if (team === undefined) throw new DomainError('NOT_FOUND', 404);
    const vote = await this.locks.lockLeaderVote<RawVote & Record<string, unknown>>(voteId);
    if (vote === undefined || vote.team_id !== teamId) throw new DomainError('NOT_FOUND', 404);
    return vote;
  }

  private requirePhase(vote: RawVote, allowed: string[]): void {
    if (!allowed.includes(vote.status)) throw new DomainError('VOTE_PHASE', 409);
  }

  private async record(
    vote: RawVote,
    type: 'candidate_nominated' | 'candidacy_confirmed' | 'candidacy_withdrawn',
    actor: string,
    payload: Record<string, unknown>,
    now: Date,
  ): Promise<void> {
    await this.events.insertMany([
      journalRow(vote.team_id, type, actor, { voteId: vote.id, ...payload }, now),
    ]);
    const row: LeaderVoteRow | undefined = await this.votes.find(vote.team_id, vote.id);
    await this.outbox.publish(
      teamsEvent('vote_updated', vote.team_id, {
        teamId: vote.team_id,
        voteId: vote.id,
        status: vote.status,
        round: row?.round ?? 1,
      }),
    );
  }
}
