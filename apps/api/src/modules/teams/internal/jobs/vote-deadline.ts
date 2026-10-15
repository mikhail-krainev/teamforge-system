import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Clock } from '../../../../platform/clock/clock.js';
import { jobId } from '../../../../platform/queues/job-id.js';
import { QueuesService } from '../../../../platform/queues/queues.service.js';

export const VOTE_DEADLINE_JOB = 'vote-deadline';
export const SUSPENSION_EXPIRE_JOB = 'suspension-expire';

/** C-28: a team without a lead stays suspended this long, then it is archived. */
export const SUSPENSION_MS = 14 * 24 * 3_600_000;
/** `team.status_reason` of a team suspended because nobody agreed to lead it. */
export const NO_LEADER_REASON = 'no_leader';

/** The phase a `vote-deadline` job was scheduled for; a job of an older phase does nothing. */
export type VoteDeadlineData = {
  voteId: string;
  status: string;
  round: number;
  /** Epoch ms of `phase_deadline` the job belongs to. */
  deadline: number;
};

export function parseVoteDeadline(data: Record<string, unknown>): VoteDeadlineData {
  const { voteId, status, round, deadline } = data;
  if (
    typeof voteId !== 'string' ||
    typeof status !== 'string' ||
    typeof round !== 'number' ||
    typeof deadline !== 'number'
  ) {
    throw new Error('vote-deadline needs voteId, status, round and deadline');
  }
  return { voteId, status, round, deadline };
}

export interface ScheduledPhase {
  id: string;
  status: string;
  round: number;
  phaseDeadline: Date | null;
}

/**
 * Delayed jobs of the leader vote (architecture 8.3, 13.12). The id is deterministic, so setting
 * the same phase twice makes one job. A lost job is not fatal: `vote-deadline-scan` finds the vote
 * by its overdue `phase_deadline`.
 */
@Injectable()
export class VoteTimers {
  constructor(
    @Inject(QueuesService) private readonly queues: QueuesService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  async scheduleDeadline(phase: ScheduledPhase): Promise<void> {
    if (phase.phaseDeadline === null) return;
    const deadline = phase.phaseDeadline.getTime();
    const data: VoteDeadlineData = {
      voteId: phase.id,
      status: phase.status,
      round: phase.round,
      deadline,
    };
    await this.add(VOTE_DEADLINE_JOB, data, {
      jobId: jobId('vote', phase.id, phase.status, phase.round, deadline),
      delayMs: this.delay(deadline),
    });
  }

  /** `suspension-expire` (C-28): the suspended team is archived after 14 days. */
  async scheduleSuspensionExpiry(teamId: string, suspendedAt: Date): Promise<void> {
    const dueAt = suspendedAt.getTime() + SUSPENSION_MS;
    await this.add(
      SUSPENSION_EXPIRE_JOB,
      { teamId },
      {
        jobId: jobId('suspensionexpire', teamId, suspendedAt.getTime()),
        delayMs: this.delay(dueAt),
      },
    );
  }

  private delay(atMs: number): number {
    return Math.max(0, atMs - this.clock.now().getTime());
  }

  private async add(
    name: string,
    data: Record<string, unknown>,
    options: { jobId: string; delayMs: number },
  ): Promise<void> {
    try {
      await this.queues.add('timers', name, data, options);
    } catch (error) {
      this.logger.error({ err: error, job: name }, 'vote timer was not scheduled');
    }
  }
}
