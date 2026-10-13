import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { type JobProcessor, ProcessorRegistry } from '../../../../platform/queues/queue-workers.js';
import type { QueueJob } from '../../../../platform/queues/queues.service.js';
import { DEPARTURE_DEFAULT_JOB } from '../services/departure-leave.service.js';
import { DepartureService } from '../services/departure.service.js';

/**
 * Processor of the `timers` queue for the jobs of teams. `departure-default` (C-14): a decision the
 * lead did not take in 7 days becomes "replace" (the seats stay open). The vote timers of S3-08
 * join the `handlers` table here, because one queue has one worker.
 */
@Injectable()
export class TeamsTimersProcessor implements JobProcessor, OnModuleInit {
  readonly queue = 'timers' as const;
  private readonly handlers = new Map<string, (job: QueueJob) => Promise<unknown>>();

  constructor(
    @Inject(ProcessorRegistry) private readonly registry: ProcessorRegistry,
    @Inject(DepartureService) private readonly departures: DepartureService,
  ) {
    this.handlers.set(DEPARTURE_DEFAULT_JOB, (job) => this.departureDefault(job));
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
}
