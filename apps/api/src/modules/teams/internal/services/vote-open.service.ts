import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import {
  NOMINATION_MS,
  VOTING_MS,
  openingCase,
  type VoteTrigger,
} from '../domain/leader-vote-machine.js';
import { VoteTimers } from '../jobs/vote-deadline.js';
import type { LeaderVoteOpenInput, LeaderVoteOpenPort } from '../ports/leader-vote-open.port.js';
import { LeaderVoteRepository, type MemberRow } from '../repositories/leader-vote.repository.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import { TeamRepository, type TeamRow } from '../repositories/team.repository.js';
import { journalRow, teamsEvent } from './team-events.js';

export interface OpenedVote {
  voteId: string;
  /** `null` when the vote was settled at once (one member left, or none). */
  status: 'nominating' | 'closed';
}

/** Members who may vote: no running trial; if nobody qualifies, every active member (8.1). */
export function eligibleMembers(members: MemberRow[], now: Date): MemberRow[] {
  const settled = members.filter(
    (m) =>
      m.trialUntil === null ||
      m.trialConfirmedAt !== null ||
      m.trialUntil.getTime() <= now.getTime(),
  );
  return settled.length > 0 ? settled : members;
}

/** Statuses of a team that can open a leader vote (architecture 8.1; `suspended` is the open point). */
const VOTABLE_STATUSES: readonly string[] = ['forming', 'active', 'suspended'];

/**
 * Opening of the leader vote (architecture 8.1, FR-TEAM-14). Always runs inside the transaction of
 * the trigger with the team locked (#4); `leader_vote_open_uq` is the last line of defence for CC-4.
 */
@Injectable()
export class VoteOpenService implements LeaderVoteOpenPort {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TeamRepository) private readonly teams: TeamRepository,
    @Inject(LeaderVoteRepository) private readonly votes: LeaderVoteRepository,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
    @Inject(VoteTimers) private readonly timers: VoteTimers,
  ) {}

  /** Port entry: the lead has just left (or deleted the account) and is already off the roster. */
  async open(input: LeaderVoteOpenInput): Promise<void> {
    const team = await this.teams.find(input.teamId);
    if (team === undefined) throw new DomainError('NOT_FOUND', 404);
    await this.openFor(team, input.trigger, input.at);
  }

  /**
   * Opens the vote of a team whose row is locked. The lead is excluded from the voters when he
   * is still on the roster (inactivity trigger). Returns what happened.
   */
  async openFor(team: TeamRow, trigger: VoteTrigger, now: Date): Promise<OpenedVote | undefined> {
    if ((await this.votes.findOpen(team.id)) !== undefined) {
      // A vote is already running (CC-4); a leaving lead only stops being the lead.
      if (trigger !== 'lead_inactive') {
        await this.teams.update(team.id, {
          leadUserId: null,
          updatedAt: now,
          version: team.version + 1,
        });
      }
      return undefined;
    }
    // A suspended team keeps its place in the vote (it comes back to `suspended` when the vote
    // closes, `status_before_vote`); any other status cannot lose its lead to a vote.
    if (!VOTABLE_STATUSES.includes(team.status)) {
      if (trigger !== 'lead_inactive') {
        await this.teams.update(team.id, {
          leadUserId: null,
          updatedAt: now,
          version: team.version + 1,
        });
      }
      return undefined;
    }
    const members = await this.votes.activeMembers(team.id);
    const pool = members.filter((m) => m.userId !== team.leadUserId || trigger !== 'lead_inactive');
    const kind = openingCase(pool.length);
    if (kind === 'archive') return this.archive(team, trigger, now);
    const first = pool[0];
    if (kind === 'sole_member' && first !== undefined) {
      return this.soleMember(team, trigger, first, now);
    }
    return this.openVote(team, trigger, eligibleMembers(pool, now), now);
  }

  private async archive(team: TeamRow, trigger: VoteTrigger, now: Date): Promise<OpenedVote> {
    const voteId = uuidv7();
    await this.insertClosed(team, voteId, trigger, 'archived', null, 0, now);
    await this.teams.update(team.id, {
      status: 'archived',
      statusReason: 'no_members',
      leadUserId: null,
      updatedAt: now,
      version: team.version + 1,
    });
    await this.outbox.publishMany([
      teamsEvent('team_status_changed', team.id, {
        teamId: team.id,
        from: team.status,
        to: 'archived',
        reason: 'no_members',
      }),
      this.voteUpdated(team.id, voteId, 'closed', 1),
    ]);
    return { voteId, status: 'closed' };
  }

  private async soleMember(
    team: TeamRow,
    trigger: VoteTrigger,
    member: MemberRow,
    now: Date,
  ): Promise<OpenedVote> {
    const voteId = uuidv7();
    await this.insertClosed(team, voteId, trigger, 'sole_member', member.userId, 1, now);
    await this.votes.insertEligible([{ voteId, userId: member.userId, joinedAt: member.joinedAt }]);
    await this.teams.update(team.id, {
      leadUserId: member.userId,
      leadLastActiveAt: now,
      updatedAt: now,
      version: team.version + 1,
    });
    await this.events.insertMany([
      journalRow(
        team.id,
        'lead_changed',
        member.userId,
        { from: team.leadUserId, to: member.userId, via: 'sole_member', voteId },
        now,
      ),
    ]);
    await this.outbox.publishMany([
      teamsEvent('lead_changed', team.id, {
        teamId: team.id,
        from: team.leadUserId,
        to: member.userId,
        via: 'sole_member',
      }),
      this.voteUpdated(team.id, voteId, 'closed', 1),
    ]);
    return { voteId, status: 'closed' };
  }

  private async insertClosed(
    team: TeamRow,
    voteId: string,
    trigger: VoteTrigger,
    outcome: 'archived' | 'sole_member',
    winner: string | null,
    eligibleCount: number,
    now: Date,
  ): Promise<void> {
    await this.votes.insertVote({
      id: voteId,
      teamId: team.id,
      trigger,
      status: 'closed',
      round: 1,
      openedAt: now,
      phaseDeadline: null,
      votingDeadline: now,
      eligibleCount,
      outcome,
      winnerUserId: winner,
      closedAt: now,
    });
  }

  private async openVote(
    team: TeamRow,
    trigger: VoteTrigger,
    eligible: MemberRow[],
    now: Date,
  ): Promise<OpenedVote> {
    const voteId = uuidv7();
    const nominationEnds = new Date(now.getTime() + NOMINATION_MS);
    await this.votes.insertVote({
      id: voteId,
      teamId: team.id,
      trigger,
      status: 'nominating',
      round: 1,
      openedAt: now,
      phaseDeadline: nominationEnds,
      votingDeadline: new Date(now.getTime() + VOTING_MS),
      eligibleCount: eligible.length,
    });
    await this.votes.insertEligible(
      eligible.map((m) => ({ voteId, userId: m.userId, joinedAt: m.joinedAt })),
    );
    await this.votes.clearRequests(team.id);
    await this.teams.update(team.id, {
      status: 'voting',
      statusBeforeVote: team.status,
      leadUserId: trigger === 'lead_inactive' ? team.leadUserId : null,
      updatedAt: now,
      version: team.version + 1,
    });
    await this.events.insertMany([
      {
        ...journalRow(team.id, 'vote_opened', '', { voteId, trigger }, now),
        actorUserId: team.leadUserId,
      },
    ]);
    await this.outbox.publishMany([
      this.statusChanged(team, 'voting'),
      this.voteUpdated(team.id, voteId, 'nominating', 1),
    ]);
    await this.timers.scheduleDeadline({
      id: voteId,
      status: 'nominating',
      round: 1,
      phaseDeadline: nominationEnds,
    });
    return { voteId, status: 'nominating' };
  }

  private statusChanged(team: TeamRow, to: string) {
    return teamsEvent('team_status_changed', team.id, {
      teamId: team.id,
      from: team.status,
      to,
      reason: 'leader_vote',
    });
  }

  voteUpdated(teamId: string, voteId: string, status: string, round: number) {
    return teamsEvent('vote_updated', teamId, { teamId, voteId, status, round });
  }
}
