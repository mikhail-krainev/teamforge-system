import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';
import { DB, type Database } from '../db/db.module.js';
import { REDIS } from '../redis/redis.module.js';
import { S3 } from '../storage/s3.module.js';

export interface CheckResult {
  status: 'ok' | 'down';
  latencyMs?: number;
}

export interface HealthReport {
  status: 'ok' | 'down';
  checks: Record<string, CheckResult>;
}

/** Total budget of /health/ready (architecture 13.5). */
export const READY_TIMEOUT_MS = 1000;

async function timed(run: (signal: AbortSignal) => Promise<unknown>): Promise<CheckResult> {
  const started = Date.now();
  const signal = AbortSignal.timeout(READY_TIMEOUT_MS);
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  });
  try {
    await Promise.race([run(signal), aborted]);
    return { status: 'ok', latencyMs: Date.now() - started };
  } catch {
    return { status: 'down', latencyMs: Date.now() - started };
  }
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(S3) private readonly s3: S3Client,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  live(): HealthReport {
    return { status: 'ok', checks: {} };
  }

  /** Mandatory dependencies in parallel: PostgreSQL (through PgBouncer), Redis, S3 buckets. */
  async ready(): Promise<HealthReport> {
    const [postgres, redis, s3] = await Promise.all([
      timed(() => this.db.execute(sql`SELECT 1`)),
      timed(() => this.redis.ping()),
      timed((signal) => this.headBuckets(signal)),
    ]);
    const checks = { postgres, redis, s3 };
    const down = Object.values(checks).some((c) => c.status === 'down');
    return { status: down ? 'down' : 'ok', checks };
  }

  private async headBuckets(signal: AbortSignal): Promise<void> {
    for (const Bucket of [this.config.S3_BUCKET_RESUMES, this.config.S3_BUCKET_ARTIFACTS]) {
      await this.s3.send(new HeadBucketCommand({ Bucket }), { abortSignal: signal });
    }
  }
}
