import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { ClsModule } from 'nestjs-cls';
import { ClockModule } from './clock/clock.module.js';
import type { AppConfig } from './config/config.js';
import { ConfigModule } from './config/config.module.js';
import { DB, DbModule } from './db/db.module.js';
import { ProblemFilter } from './errors/problem.filter.js';
import { HealthModule } from './health/health.module.js';
import { OperationContextInterceptor } from './http/operation-context.interceptor.js';
import { IdempotencyModule } from './idempotency/idempotency.module.js';
import { LoggingModule, type LoggingOptions } from './logging/logging.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { QueuesModule } from './queues/queues.module.js';
import { RateLimitModule } from './ratelimit/ratelimit.module.js';
import { RedisModule } from './redis/redis.module.js';
import { S3Module } from './storage/s3.module.js';
import { TxModule } from './tx/tx.module.js';

export interface PlatformOptions {
  /** HTTP process (api) or background process (worker). */
  http: boolean;
  logging?: LoggingOptions;
}

function clsModule(http: boolean): DynamicModule {
  const plugin = new ClsPluginTransactional({
    imports: [DbModule],
    // READ COMMITTED is explicit (architecture 12.1); an empty option object would make drizzle
    // emit a bare "set transaction" statement.
    adapter: new TransactionalAdapterDrizzleOrm({
      drizzleInstanceToken: DB,
      defaultTxOptions: { isolationLevel: 'read committed' },
    }),
  });
  return ClsModule.forRoot({
    global: true,
    plugins: [plugin],
    middleware: http
      ? {
          mount: true,
          setup: (cls, req: { id?: unknown }) => cls.set('requestId', String(req.id ?? '')),
        }
      : undefined,
  });
}

/** Shared infrastructure of the api and worker processes (architecture 1, 13). */
@Module({})
export class PlatformModule {
  static forRoot(config: AppConfig, options: PlatformOptions): DynamicModule {
    const common = [
      ConfigModule.forRoot(config),
      ClockModule,
      clsModule(options.http),
      LoggingModule.forRoot(options.logging),
      DbModule,
      RedisModule,
      S3Module,
      QueuesModule,
      TxModule,
      RateLimitModule,
      IdempotencyModule,
      OutboxModule,
    ];
    return {
      module: PlatformModule,
      imports: options.http ? [...common, HealthModule] : common,
      providers: options.http
        ? [
            { provide: APP_FILTER, useClass: ProblemFilter },
            { provide: APP_INTERCEPTOR, useClass: OperationContextInterceptor },
          ]
        : [],
    };
  }
}
