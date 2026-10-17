import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { and, isNotNull, lt } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { Clock } from '../clock/clock.js';
import { DB, type Database } from '../db/db.module.js';
import { inboxEvent, outboxEvent } from '../db/schema/platform.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { MaintenanceTasks, RepeatingJobs } from '../queues/maintenance-tasks.js';
import { type JobProcessor, ProcessorRegistry } from '../queues/queue-workers.js';
import { QueuesService, type QueueJob } from '../queues/queues.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
export const OUTBOX_RETENTION_DAYS = 7;
export const INBOX_RETENTION_DAYS = 14;

/** `maintenance` queue: hourly cleanups (idempotency keys, published outbox rows, old inbox rows). */
@Injectable()
export class MaintenanceProcessor implements JobProcessor, OnModuleInit, OnApplicationBootstrap {
  readonly queue = 'maintenance' as const;

  constructor(
    @Inject(ProcessorRegistry) private readonly registry: ProcessorRegistry,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(QueuesService) private readonly queues: QueuesService,
    @Inject(MaintenanceTasks) private readonly tasks: MaintenanceTasks,
    @Inject(RepeatingJobs) private readonly repeating: RepeatingJobs,
    @Inject(DB) private readonly db: Database,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** Repeatable jobs with fixed scheduler keys: re-registering on every start is idempotent. */
  async onApplicationBootstrap(): Promise<void> {
    const queue = this.queues.getQueue('maintenance');
    for (const name of ['idempotency-cleanup', 'outbox-cleanup']) {
      await queue.upsertJobScheduler(name, { every: HOUR_MS }, { name, data: {} });
    }
    for (const task of this.tasks.all()) {
      await queue.upsertJobScheduler(
        task.name,
        { every: task.everyMs },
        { name: task.name, data: {} },
      );
    }
    for (const job of this.repeating.all()) {
      await this.queues
        .getQueue(job.queue)
        .upsertJobScheduler(job.key, { every: job.everyMs }, { name: job.jobName, data: {} });
    }
  }

  async process(job: QueueJob): Promise<number> {
    const removed = await this.dispatch(job.name);
    this.logger.info({ job: job.name, removed }, 'maintenance job done');
    return removed;
  }

  private dispatch(name: string): Promise<number> {
    switch (name) {
      case 'idempotency-cleanup':
        return this.idempotency.deleteExpired();
      case 'outbox-cleanup':
        return this.cleanOutbox();
      default:
        return this.runRegistered(name);
    }
  }

  private async runRegistered(name: string): Promise<number> {
    const task = this.tasks.get(name);
    if (task === undefined) throw new Error(`Unknown maintenance job: ${name}`);
    return task.run();
  }

  async cleanOutbox(): Promise<number> {
    const now = this.clock.now().getTime();
    const published = await this.db
      .delete(outboxEvent)
      .where(
        and(
          isNotNull(outboxEvent.publishedAt),
          lt(outboxEvent.publishedAt, new Date(now - OUTBOX_RETENTION_DAYS * DAY_MS)),
        ),
      )
      .returning({ id: outboxEvent.id });
    const inbox = await this.db
      .delete(inboxEvent)
      .where(lt(inboxEvent.processedAt, new Date(now - INBOX_RETENTION_DAYS * DAY_MS)))
      .returning({ id: inboxEvent.eventId });
    return published.length + inbox.length;
  }
}
