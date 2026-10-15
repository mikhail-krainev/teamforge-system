import { Inject, Injectable } from '@nestjs/common';
import { InvariantError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { LockService } from '../../../../platform/tx/locks.js';
import type {
  LeaderVoteLeaveInput,
  LeaderVoteLeavePort,
  LeaderVoteLeaveResult,
} from '../ports/leader-vote-leave.port.js';
import { LeaderVoteRepository, type LeaderVoteRow } from '../repositories/leader-vote.repository.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import { TeamRepository } from '../repositories/team.repository.js';
import { statusJournalRow } from './start-events.js';
import { journalRow, teamsEvent } from './team-events.js';
import { VoteFlowService } from './vote-flow.service.js';

/**
 * A departure seen by the leader vote (FR-TEAM-14, -20; architecture 8.2, R-14). With nobody left the
 * team is archived and an open vote closes with it. Otherwise a leaver who is a candidate is
 * withdrawn, and a leaver who was asked to lead
 * (the winner to confirm, or the senior member) has declined: the vote moves on in the same
 * transaction instead of waiting for the 24 hours. Order of locks: #1 -> #4 -> #5 -> #6 -> #7.
 */
@Injectable()
export class VoteLeaveService implements LeaderVoteLeavePort {
  constructor(
    @Inject(LockService) private readonly locks: LockService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TeamRepository) private readonly teams: TeamRepository,
    @Inject(LeaderVoteRepository) private readonly votes: LeaderVoteRepository,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
    @Inject(VoteFlowService) private readonly flow: VoteFlowService,
  ) {}

  async afterLeave(input: LeaderVoteLeaveInput): Promise<LeaderVoteLeaveResult> {
    const open = await this.votes.findOpen(input.teamId);
    if (open === undefined) {
      // A leaving lead of an empty team is archived with a vote record by `LeaderVoteOpenPort`.
      if (input.remaining > 0 || input.wasLead) return { archived: false };
      await this.archive(input, undefined);
      return { archived: true };
    }
    await this.locks.lockLeaderVote(open.id);
    const vote = await this.votes.find(input.teamId, open.id);
    if (vote === undefined) throw new InvariantError('the open vote disappeared under its lock');
    const offer = await this.votes.pendingOffer(vote.id);
    if (input.remaining === 0) {
      await this.flow.closeEmptied(vote, offer, input.at);
      await this.archive(input, vote.id);
      return { archived: true };
    }
    await this.withdrawCandidacy(vote, input);
    if (offer?.userId === input.userId) {
      await this.flow.answer(vote, offer, 'declined', input.at);
    }
    return { archived: false };
  }

  /** A candidate who leaves is taken off the ballot (R-14); the ballots cast for him no longer count. */
  private async withdrawCandidacy(vote: LeaderVoteRow, input: LeaderVoteLeaveInput): Promise<void> {
    if (!(await this.votes.withdrawCandidateIfAny(vote.id, input.userId, input.at))) return;
    await this.events.insertMany([
      journalRow(
        vote.teamId,
        'candidacy_withdrawn',
        input.userId,
        { voteId: vote.id, candidateUserId: input.userId, reason: 'left_team' },
        input.at,
      ),
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

  private async archive(input: LeaderVoteLeaveInput, voteId: string | undefined): Promise<void> {
    const team = await this.teams.find(input.teamId);
    if (team === undefined) throw new InvariantError('the team of the leave is gone');
    await this.teams.update(team.id, {
      status: 'archived',
      statusReason: 'no_members',
      leadUserId: null,
      statusBeforeVote: null,
      updatedAt: input.at,
      version: team.version + 1,
    });
    const change = { from: team.status, to: 'archived', reason: 'no_members' };
    await this.events.insertMany([
      statusJournalRow(
        team.id,
        'team_status_changed',
        null,
        voteId === undefined ? change : { ...change, voteId },
        input.at,
      ),
    ]);
    await this.outbox.publishMany([
      teamsEvent('team_status_changed', team.id, { teamId: team.id, ...change }),
    ]);
  }
}
