import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { type Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { ClsService } from 'nestjs-cls';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';
import { InvariantError } from '../errors/domain-error.js';
import { REDIS_BULL } from '../redis/redis.module.js';
import { assertValidJobId } from './job-id.js';
import { defaultJobOptions, QUEUE_DEFINITIONS, type QueueName } from './queue-definitions.js';

export interface AddJobOptions {
  /** Deterministic id built with `jobId(...)`: a second add with the same id is a no-op. */
  jobId: string;
  delayMs?: number;
}

/** Job payloads carry ids only and the originating request id (architecture 13.4, 13.12). */
export type JobData = Record<string, unknown> & { requestId?: string };

export type QueueJob = Job<JobData>;

@Injectable()
export class QueuesService implements OnApplicationShutdown {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(
    @Inject(REDIS_BULL) private readonly connection: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  get prefix(): string {
    return this.config.QUEUE_PREFIX;
  }

  getQueue(name: QueueName): Queue {
    const existing = this.queues.get(name);
    if (existing) return existing;
    if (QUEUE_DEFINITIONS[name].redis !== 'main') {
      throw new InvariantError(`Queue ${name} lives in redis-resume, which is not wired yet`);
    }
    const queue = new Queue(name, {
      connection: this.connection,
      prefix: this.config.QUEUE_PREFIX,
      defaultJobOptions: defaultJobOptions(name),
    });
    queue.on('error', () => undefined);
    this.queues.set(name, queue);
    return queue;
  }

  /** Adds a job; the request id is propagated into the payload for log correlation. */
  async add(
    queue: QueueName,
    jobName: string,
    data: JobData,
    options: AddJobOptions,
  ): Promise<void> {
    assertValidJobId(options.jobId);
    const requestId = data.requestId ?? this.currentRequestId();
    const payload: JobData = requestId === undefined ? data : { ...data, requestId };
    await this.getQueue(queue).add(jobName, payload, {
      jobId: options.jobId,
      delay: options.delayMs,
    });
  }

  private currentRequestId(): string | undefined {
    return this.cls.isActive() ? this.cls.get('requestId') : undefined;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((queue) => queue.close()));
  }
}
