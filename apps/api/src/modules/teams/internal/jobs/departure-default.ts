import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { TimerHandlers } from '../../../../platform/queues/maintenance-tasks.js';
import { type JobProcessor, ProcessorRegistry } from '../../../../platform/queues/queue-workers.js';
import type { QueueJob } from '../../../../platform/queues/queues.service.js';
import { DEPARTURE_DEFAULT_JOB } from '../services/departure-leave.service.js';
import { DepartureService } from '../services/departure.service.js';
import { TrialService } from '../services/trial.service.js';
import { VoteDeadlineService } from '../services/vote-deadline.service.js';
import { TRIAL_EXPIRE_JOB, parseTrialExpire } from './trial-expire.js';
import { SUSPENSION_EXPIRE_JOB, VOTE_DEADLINE_JOB, parseVoteDeadline } from './vote-deadline.js';

/**
 * Processor of the `timers` queue for the jobs of teams. `departure-default` (C-14): a decision the
 * lead did not take in 7 days becomes "replace" (the seats stay open). `vote-deadline` and
 * `suspension-expire` (S3-08) and `trial-expire` (S4-06, FR-TEAM-24) share the `handlers` table, because one queue has one worker;
 * the names of the other modules (`rewards-cooling-end`, `review-publish`) come from `TimerHandlers`.
 */
@Injectable()
export class TeamsTimersProcessor implements JobProcessor, OnModuleInit {
  readonly queue = 'timers' as const;
  private readonly handlers = new Map<string, (job: QueueJob) => Promise<unknown>>();

  constructor(
    @Inject(ProcessorRegistry) private readonly registry: ProcessorRegistry,
    @Inject(DepartureService) private readonly departures: DepartureService,
    @Inject(VoteDeadlineService) private readonly voteDeadlines: VoteDeadlineService,
    @Inject(TrialService) private readonly trials: TrialService,
    @Inject(TimerHandlers) private readonly moduleTimers: TimerHandlers,
  ) {
    this.handlers.set(DEPARTURE_DEFAULT_JOB, (job) => this.departureDefault(job));
    this.handlers.set(VOTE_DEADLINE_JOB, (job) => {
      const phase = parseVoteDeadline(job.data);
      return this.voteDeadlines.process(phase.voteId, phase);
    });
    this.handlers.set(SUSPENSION_EXPIRE_JOB, (job) => this.suspensionExpire(job));
    this.handlers.set(TRIAL_EXPIRE_JOB, (job) => this.trials.expire(parseTrialExpire(job.data)));
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  process(job: QueueJob): Promise<unknown> {
    const handler = this.handlers.get(job.name);
    if (handler !== undefined) return handler(job);
    // Jobs of the other modules (rewards, profiles) register their names in `TimerHandlers`.
    const moduleHandler = this.moduleTimers.get(job.name);
    if (moduleHandler === undefined) throw new Error(`Unknown timers job: ${job.name}`);
    return moduleHandler(job.data);
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
