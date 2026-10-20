import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { QueueEvents } from 'bullmq';
import type { Redis } from 'ioredis';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';
import { REDIS_BULL } from '../redis/redis.module.js';
import type { QueueName } from './queue-definitions.js';

/**
 * A reader of the results of a queue that another process consumes (the `link-check` queue is served
 * by the `link-checker`, which has no database: the `worker` applies what it answered).
 */
export interface QueueResultListener {
  readonly queue: QueueName;
  /** Must be idempotent: events can arrive twice (several workers listen) or be missed (a sweep repairs that). */
  handle(jobId: string, result: unknown): Promise<void>;
}

@Injectable()
export class ResultListeners {
  private readonly listeners: QueueResultListener[] = [];

  register(listener: QueueResultListener): void {
    this.listeners.push(listener);
  }

  all(): readonly QueueResultListener[] {
    return this.listeners;
  }
}

/** BullMQ sends the return value as JSON text on some versions and parsed on others. */
export function resultOf(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Process `worker` only: one `QueueEvents` per registered queue, `completed` goes to the listener. */
@Injectable()
export class ResultListenerRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly events: QueueEvents[] = [];

  constructor(
    @Inject(ResultListeners) private readonly registry: ResultListeners,
    @Inject(REDIS_BULL) private readonly connection: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ClsService) private readonly cls: ClsService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const listener of this.registry.all()) {
      const events = new QueueEvents(listener.queue, {
        connection: this.connection,
        prefix: this.config.QUEUE_PREFIX,
      });
      events.on('error', (error) =>
        this.logger.error({ err: error, queue: listener.queue }, 'queue events error'),
      );
      events.on('completed', ({ jobId, returnvalue }) => {
        void this.deliver(listener, jobId, returnvalue);
      });
      this.events.push(events);
    }
    await Promise.all(this.events.map((events) => events.waitUntilReady()));
  }

  private async deliver(
    listener: QueueResultListener,
    jobId: string,
    returnvalue: unknown,
  ): Promise<void> {
    try {
      await this.cls.run(() => listener.handle(jobId, resultOf(returnvalue)));
    } catch (error) {
      this.logger.error({ err: error, queue: listener.queue, job_id: jobId }, 'result not applied');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.events.map((events) => events.close()));
  }
}
