import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { type JobProcessor, ProcessorRegistry } from '../../../../platform/queues/queue-workers.js';
import type { QueueJob } from '../../../../platform/queues/queues.service.js';
import { DEPARTURE_DEFAULT_JOB } from '../services/departure-leave.service.js';
import { DepartureService } from '../services/departure.service.js';
import { VoteDeadlineService } from '../services/vote-deadline.service.js';
import { SUSPENSION_EXPIRE_JOB, VOTE_DEADLINE_JOB, parseVoteDeadline } from './vote-deadline.js';

/**
 * Processor of the `timers` queue for the jobs of teams. `departure-default` (C-14): a decision the
 * lead did not take in 7 days becomes "replace" (the seats stay open). `vote-deadline` and
 * `suspension-expire` (S3-08) share the `handlers` table, because one queue has one worker.
 */
@Injectable()
export class TeamsTimersProcessor implements JobProcessor, OnModuleInit {
  readonly queue = 'timers' as const;
  private readonly handlers = new Map<string, (job: QueueJob) => Promise<unknown>>();

  constructor(
    @Inject(ProcessorRegistry) private readonly registry: ProcessorRegistry,
    @Inject(DepartureService) private readonly departures: DepartureService,
    @Inject(VoteDeadlineService) private readonly voteDeadlines: VoteDeadlineService,
  ) {
    this.handlers.set(DEPARTURE_DEFAULT_JOB, (job) => this.departureDefault(job));
    this.handlers.set(VOTE_DEADLINE_JOB, (job) => {
      const phase = parseVoteDeadline(job.data);
      return this.voteDeadlines.process(phase.voteId, phase);
    });
    this.handlers.set(SUSPENSION_EXPIRE_JOB, (job) => this.suspensionExpire(job));
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  process(job: QueueJob): Promise<unknown> {
    const handler = this.handlers.get(job.name);
    if (handler === undefined) throw new Error(`Unknown timers job: ${job.name}`);
    return handler(job);
  }

  private departureDefault(job: QueueJob): Promise<boolean> {
    const { departureId } = job.data as { departureId?: unknown };
    if (typeof departureId !== 'string') throw new Error('departure-default needs a departureId');
    return this.departures.applyDefault(departureId);
  }

  private suspensionExpire(job: QueueJob): Promise<boolean> {
    const { teamId } = job.data as { teamId?: unknown };
    if (typeof teamId !== 'string') throw new Error('suspension-expire needs a teamId');
    return this.voteDeadlines.expireSuspension(teamId);
  }
}
