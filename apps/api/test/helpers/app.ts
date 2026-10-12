import { Writable } from 'node:stream';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { Clock } from '../../src/platform/clock/clock.js';
import { type AppConfig, loadConfig } from '../../src/platform/config/config.js';
import { DB } from '../../src/platform/db/db.module.js';
import { buildFastifyAdapter, configureHttpApp } from '../../src/platform/http/fastify.js';
import { createTestTables } from '../../src/platform/testing/test-tables.js';
import { WorkerModule } from '../../src/worker.module.js';
import { validEnv } from './env.js';
import { type FakeS3, startFakeS3 } from './fake-s3.js';
import { uniqueQueuePrefix } from './infra.js';

export interface TestAppOptions {
  /** App database URL; defaults to an unreachable server. */
  databaseUrl?: string;
  redisUrl?: string;
  /** Extra environment overrides (e.g. S3_ENDPOINT to simulate an outage). */
  env?: Record<string, string | undefined>;
  clock?: Clock;
  queuePrefix?: string;
}

export interface TestApp {
  app: NestFastifyApplication;
  config: AppConfig;
  logs: string[];
  s3: FakeS3;
  close(): Promise<void>;
}

const UNREACHABLE_PG = 'postgres://teamforge:pw@127.0.0.1:1/teamforge';
const UNREACHABLE_REDIS = 'redis://127.0.0.1:1';

function buildConfig(
  options: TestAppOptions,
  role: 'api' | 'worker',
  s3Endpoint?: string,
): AppConfig {
  return loadConfig(
    validEnv({
      DATABASE_URL: options.databaseUrl ?? UNREACHABLE_PG,
      REDIS_URL: options.redisUrl ?? process.env.REDIS_URL ?? UNREACHABLE_REDIS,
      QUEUE_PREFIX: options.queuePrefix ?? uniqueQueuePrefix(),
      ...(s3Endpoint ? { S3_ENDPOINT: s3Endpoint } : {}),
      ...options.env,
    }),
    role,
  );
}

function logSink(lines: string[]): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      callback();
    },
  });
}

/** Full HTTP application on Fastify, driven with `app.inject`. */
export async function createTestApp(
  options: TestAppOptions = {},
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<TestApp> {
  const s3 = await startFakeS3(['resumes', 'artifacts']);
  const config = buildConfig(options, 'api', s3.endpoint);
  const logs: string[] = [];
  let builder = Test.createTestingModule({
    imports: [AppModule.forRoot(config, { logging: { stream: logSink(logs) } })],
  });
  if (options.clock) builder = builder.overrideProvider(Clock).useValue(options.clock);
  const moduleRef = await customize(builder).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(buildFastifyAdapter(config));
  configureHttpApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (options.databaseUrl) await createTestTables(app.get(DB));
  return {
    app,
    config,
    logs,
    s3,
    async close() {
      await app.close();
      await s3.close();
    },
  };
}

/** Worker application context (processors, outbox relay) against real PostgreSQL and Redis. */
export async function createTestWorker(
  options: TestAppOptions,
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<{ context: INestApplicationContext; config: AppConfig; close(): Promise<void> }> {
  const config = buildConfig(options, 'worker');
  let builder = Test.createTestingModule({ imports: [WorkerModule.forRoot(config)] });
  if (options.clock) builder = builder.overrideProvider(Clock).useValue(options.clock);
  const moduleRef = await customize(builder).compile();
  const context = await moduleRef.init();
  return { context, config, close: () => context.close() };
}
