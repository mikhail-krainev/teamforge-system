import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { transition } from '../domain/leader-vote-machine.js';
import { LeaderVoteRepository } from '../repositories/leader-vote.repository.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import { TeamRepository } from '../repositories/team.repository.js';
import { journalRow, teamsEvent } from './team-events.js';
import type { LeaderVoteDto } from './vote-dto.js';
import { VoteFlowService } from './vote-flow.service.js';
import { VoteLock } from './vote-lock.js';
import { VoteQueryService } from './vote-query.service.js';

/**
 * returnAsLead (FR-TEAM-14; architecture 8.1): the lead whose inactivity opened the vote says he is
 * back. The vote is cancelled while no ballot has been cast, and the team returns to the status it
 * had before the vote. Locks #4 team -> #7 vote. Reading the votes never does this.
 */
@Injectable()
export class VoteLeadReturnService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(VoteLock) private readonly lock: VoteLock,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TeamRepository) private readonly teams: TeamRepository,
    @Inject(LeaderVoteRepository) private readonly votes: LeaderVoteRepository,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
    @Inject(VoteQueryService) private readonly query: VoteQueryService,
    @Inject(VoteFlowService) private readonly flow: VoteFlowService,
  ) {}

  async returnAsLead(userId: string, teamId: string, voteId: string): Promise<LeaderVoteDto> {
    await this.tx.run(async () => {
      const vote = await this.lock.lock(teamId, voteId);
      const team = await this.teams.find(teamId);
      if (team === undefined) throw new DomainError('NOT_FOUND', 404);
      if (team.leadUserId !== userId) throw new DomainError('NOT_TEAM_LEAD', 403);
      if (vote.trigger !== 'lead_inactive' || team.status !== 'voting') {
        throw new DomainError('INVALID_STATE', 409);
      }
      const next = transition(this.flow.stateOf(vote), {
        type: 'lead_returned',
        ballotsCast: (await this.votes.anyBallot(vote.id)) ? 1 : 0,
      });
      if (next === undefined) throw new DomainError('INVALID_STATE', 409);
      const now = this.clock.now();
      const restored = team.statusBeforeVote ?? 'active';
      await this.votes.updateVote(vote.id, {
        status: next.status,
        outcome: next.outcome,
        phaseDeadline: null,
        closedAt: now,
      });
      await this.teams.update(teamId, {
        status: restored,
        statusBeforeVote: null,
        leadLastActiveAt: now,
        updatedAt: now,
        version: team.version + 1,
      });
      await this.events.insertMany([
        journalRow(teamId, 'vote_cancelled', userId, { voteId: vote.id }, now),
      ]);
      await this.outbox.publishMany([
        teamsEvent('vote_updated', teamId, {
          teamId,
          voteId: vote.id,
          status: next.status,
          round: vote.round,
        }),
        teamsEvent('team_status_changed', teamId, {
          teamId,
          from: 'voting',
          to: restored,
          reason: 'vote_cancelled',
        }),
      ]);
    });
    return this.query.get(userId, teamId, voteId);
  }
}
