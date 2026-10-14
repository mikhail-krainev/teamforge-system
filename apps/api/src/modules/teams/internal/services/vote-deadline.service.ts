import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Clock } from '../../../../platform/clock/clock.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { isOpenStatus } from '../domain/leader-vote-machine.js';
import { NO_LEADER_REASON, SUSPENSION_MS, type VoteDeadlineData } from '../jobs/vote-deadline.js';
import { LeaderVoteRepository } from '../repositories/leader-vote.repository.js';
import { TeamEventRepository } from '../repositories/team-event.repository.js';
import { TeamRepository } from '../repositories/team.repository.js';
import { statusJournalRow } from './start-events.js';
import { teamsEvent } from './team-events.js';
import { VoteFlowService } from './vote-flow.service.js';
import { VoteLock } from './vote-lock.js';

export const DEADLINE_SCAN_BATCH = 100;

/**
 * Deadlines of the leader vote (architecture 8.3): the `vote-deadline` job, the minute scan that
 * is the safety net for lost jobs, and `suspension-expire` (C-28). Every step re-reads the state
 * under locks #4 -> #7, so a stale job, a second scan or a ballot at the same moment change
 * nothing twice (CC-4 (c)).
 */
@Injectable()
export class VoteDeadlineService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
    @Inject(VoteLock) private readonly lock: VoteLock,
    @Inject(VoteFlowService) private readonly flow: VoteFlowService,
    @Inject(TeamRepository) private readonly teams: TeamRepository,
    @Inject(LeaderVoteRepository) private readonly votes: LeaderVoteRepository,
    @Inject(TeamEventRepository) private readonly events: TeamEventRepository,
  ) {}

  /**
   * Moves the vote on when its phase is over. `expected` is the phase a delayed job was set for;
   * a job of an older phase leaves the vote alone.
   */
  process(voteId: string, expected?: VoteDeadlineData): Promise<boolean> {
    return this.tx.run(async () => {
      const known = await this.votes.findById(voteId);
      if (known === undefined || !isOpenStatus(known.status)) return false;
      const vote = await this.lock.lock(known.teamId, voteId);
      if (expected !== undefined && !this.matches(vote, expected)) return false;
      return this.flow.processDue(vote, this.clock.now());
    });
  }

  private matches(
    vote: { status: string; round: number; phaseDeadline: Date | null },
    expected: VoteDeadlineData,
  ): boolean {
    return (
      vote.status === expected.status &&
      vote.round === expected.round &&
      vote.phaseDeadline?.getTime() === expected.deadline
    );
  }

  /** `suspension-expire`: 14 days without a lead -> `archived` without credit (FR-TEAM-20). */
  expireSuspension(teamId: string): Promise<boolean> {
    return this.tx.run(async () => {
      if ((await this.locks.lockTeam(teamId)) === undefined) return false;
      const team = await this.teams.find(teamId);
      const now = this.clock.now();
      if (
        team?.status !== 'suspended' ||
        team.statusReason !== NO_LEADER_REASON ||
        team.suspendedAt === null ||
        team.suspendedAt.getTime() + SUSPENSION_MS > now.getTime()
      ) {
        return false;
      }
      await this.teams.update(teamId, {
        status: 'archived',
        statusReason: 'suspension_expired',
        updatedAt: now,
        version: team.version + 1,
      });
      const change = { from: 'suspended', to: 'archived', reason: 'suspension_expired' };
      await this.events.insertMany([
        statusJournalRow(teamId, 'team_status_changed', null, change, now),
      ]);
      await this.outbox.publish(teamsEvent('team_status_changed', teamId, { teamId, ...change }));
      return true;
    });
  }

  /** Overdue votes and suspensions, found by their indexes without locks, then each one alone. */
  async scan(): Promise<number> {
    const now = this.clock.now();
    let handled = 0;
    for (const vote of await this.votes.dueVotes(now, DEADLINE_SCAN_BATCH)) {
      handled += await this.safely(`vote ${vote.id}`, () => this.process(vote.id));
    }
    const cutoff = new Date(now.getTime() - SUSPENSION_MS);
    for (const teamId of await this.teams.suspendedSince(
      NO_LEADER_REASON,
      cutoff,
      DEADLINE_SCAN_BATCH,
    )) {
      handled += await this.safely(`team ${teamId}`, () => this.expireSuspension(teamId));
    }
    return handled;
  }

  private async safely(what: string, run: () => Promise<boolean>): Promise<number> {
    try {
      return (await run()) ? 1 : 0;
    } catch (error) {
      this.logger.error({ err: error }, `vote-deadline-scan failed for ${what}`);
      return 0;
    }
  }
}
