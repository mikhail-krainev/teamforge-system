import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';
import { verifyRedisAcl } from './redis-acl.js';

/** Commands client (rate limits, health, publish). Fails fast instead of queueing forever. */
export const REDIS = Symbol('REDIS');
/** Connection for BullMQ: blocking commands require maxRetriesPerRequest = null. */
export const REDIS_BULL = Symbol('REDIS_BULL');
/**
 * BullMQ connection to the isolated `redis-resume` instance (architecture 13.15), or null when
 * REDIS_RESUME_URL is not set. Only the worker process puts jobs there.
 */
export const REDIS_RESUME_BULL = Symbol('REDIS_RESUME_BULL');

export function createRedisClient(url: string, options: { forBull: boolean }): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: options.forBull ? null : 2,
    enableReadyCheck: true,
    connectionName: options.forBull ? 'teamforge-bull' : 'teamforge-cmd',
    lazyConnect: false,
  });
  // Connection errors surface through /health/ready and command failures; avoid unhandled events.
  client.on('error', () => undefined);
  return client;
}

@Injectable()
class RedisLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS) private readonly commands: Redis,
    @Inject(REDIS_BULL) private readonly bull: Redis,
    @Inject(REDIS_RESUME_BULL) private readonly resume: Redis | null,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([
      this.commands.quit(),
      this.bull.quit(),
      ...(this.resume === null ? [] : [this.resume.quit()]),
    ]);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: async (config: AppConfig): Promise<Redis> => {
        const client = createRedisClient(config.REDIS_URL, { forBull: false });
        await verifyRedisAcl(client, config.REDIS_URL, config.REDIS_ACL_STRICT);
        return client;
      },
    },
    {
      provide: REDIS_BULL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Redis =>
        createRedisClient(config.REDIS_URL, { forBull: true }),
    },
    {
      provide: REDIS_RESUME_BULL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Redis | null =>
        config.REDIS_RESUME_URL === undefined
          ? null
          : createRedisClient(config.REDIS_RESUME_URL, { forBull: true }),
    },
    RedisLifecycle,
  ],
  exports: [REDIS, REDIS_BULL, REDIS_RESUME_BULL],
})
export class RedisModule {}
