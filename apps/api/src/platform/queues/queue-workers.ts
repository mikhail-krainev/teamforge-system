import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { sanitizeDatabaseError } from '../logging/serializers.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';
import { REDIS_BULL } from '../redis/redis.module.js';
import { QUEUE_DEFINITIONS, type QueueName } from './queue-definitions.js';
import type { QueueJob } from './queues.service.js';

/** A BullMQ processor. Registered with ProcessorRegistry in the worker process only. */
export interface JobProcessor {
  readonly queue: QueueName;
  process(job: QueueJob): Promise<unknown>;
  /** Called once when the last retry failed (dead-letter hook). */
  onExhausted?(job: QueueJob, error: Error): Promise<void>;
}

@Injectable()
export class ProcessorRegistry {
  private readonly processors: JobProcessor[] = [];

  register(processor: JobProcessor): void {
    this.processors.push(processor);
  }

  all(): readonly JobProcessor[] {
    return this.processors;
  }
}

/** Starts one BullMQ Worker per registered queue with the configured concurrency. */
@Injectable()
export class QueueWorkers implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly workers: Worker[] = [];

  constructor(
    @Inject(ProcessorRegistry) private readonly registry: ProcessorRegistry,
    @Inject(REDIS_BULL) private readonly connection: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ClsService) private readonly cls: ClsService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  onApplicationBootstrap(): void {
    for (const processor of this.registry.all()) this.workers.push(this.start(processor));
  }

  private start(processor: JobProcessor): Worker {
    const worker = new Worker(
      processor.queue,
      (job: QueueJob) => this.runInContext(processor, job),
      {
        connection: this.connection,
        prefix: this.config.QUEUE_PREFIX,
        concurrency: QUEUE_DEFINITIONS[processor.queue].concurrency,
      },
    );
    worker.on('error', (error) =>
      this.logger.error({ err: error, queue: processor.queue }, 'worker error'),
    );
    worker.on('failed', (job, error) => {
      void this.handleFailure(processor, job as QueueJob | undefined, error);
    });
    return worker;
  }

  private runInContext(processor: JobProcessor, job: QueueJob): Promise<unknown> {
    return this.cls.run(async () => {
      this.cls.set('requestId', job.data.requestId);
      try {
        return await processor.process(job);
      } catch (error) {
        // BullMQ stores the error message and stack in Redis (7 days): no SQL parameters there.
        throw sanitizeDatabaseError(error) ?? error;
      }
    });
  }

  private async handleFailure(
    processor: JobProcessor,
    job: QueueJob | undefined,
    error: Error,
  ): Promise<void> {
    if (job === undefined) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    const fields = { queue: processor.queue, job: job.name, job_id: job.id, err: error };
    if (!exhausted) {
      this.logger.warn(fields, 'job failed, will retry');
      return;
    }
    this.logger.error(fields, 'job failed permanently');
    try {
      await processor.onExhausted?.(job, error);
    } catch (hookError) {
      this.logger.error({ ...fields, err: hookError }, 'onExhausted hook failed');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.workers.map((worker) => worker.close()));
  }
}
