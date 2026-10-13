import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { transition } from '../domain/leader-vote-machine.js';
import { LeaderVoteRepository } from '../repositories/leader-vote.repository.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import { TeamRepository } from '../repositories/team.repository.js';
import { journalRow, teamsEvent } from './team-events.js';

interface RawVote {
  id: string;
}

/**
 * The lead acts again (architecture 8.1): a vote opened for inactivity is cancelled while no
 * ballot has been cast, and the team returns to the status it had before the vote.
 * Called with the team locked (#4); takes #7.
 */
@Injectable()
export class VoteLeadReturnService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TeamRepository) private readonly teams: TeamRepository,
    @Inject(LeaderVoteRepository) private readonly votes: LeaderVoteRepository,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
  ) {}

  /**
   * The lead opens the vote screen (the one thing a lead of a `voting` team can do, because every
   * other lead action is blocked by the status): the vote of his inactivity is cancelled.
   */
  async leadReturned(teamId: string, userId: string): Promise<void> {
    const team = await this.teams.find(teamId);
    if (team === undefined || team.leadUserId !== userId || team.status !== 'voting') return;
    await this.tx.run(async () => {
      if ((await this.locks.lockTeam(teamId)) === undefined) return;
      const locked = await this.teams.find(teamId);
      if (locked?.leadUserId !== userId || locked.status !== 'voting') return;
      await this.onLeadAction(teamId, userId);
    });
  }

  /** Returns the status of the team after the call (`undefined` when nothing was cancelled). */
  async onLeadAction(teamId: string, leadUserId: string): Promise<string | undefined> {
    const open = await this.votes.findOpen(teamId);
    if (open === undefined || open.trigger !== 'lead_inactive') return undefined;
    const locked = await this.locks.lockLeaderVote<RawVote & Record<string, unknown>>(open.id);
    const vote = locked === undefined ? undefined : await this.votes.find(teamId, open.id);
    if (vote === undefined) return undefined;
    const next = transition(
      { status: vote.status as 'nominating', round: vote.round as 1, extended: vote.extended },
      { type: 'lead_returned', ballotsCast: (await this.votes.anyBallot(vote.id)) ? 1 : 0 },
    );
    if (next === undefined) return undefined;
    const team = await this.teams.find(teamId);
    if (team === undefined) return undefined;
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
      journalRow(teamId, 'vote_cancelled', leadUserId, { voteId: vote.id }, now),
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
    return restored;
  }
}
