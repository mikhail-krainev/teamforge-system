import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { sql } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import type { Database } from '../db/db.module.js';
import { lockTimeoutError } from '../errors/domain-error.js';
import { findPgError, isRetryableTxError, PG_LOCK_NOT_AVAILABLE } from '../errors/pg-errors.js';
import { TxHooks } from './tx-hooks.js';

export type Tx = Database;
export type TxHost = TransactionHost<TransactionalAdapterDrizzleOrm<Database>>;

export interface TxOptions {
  /** PostgreSQL interval literal, default '5s' (C-62). */
  lockTimeout?: string;
  /** Default '10s'. */
  statementTimeout?: string;
  /** Retries after 40P01/40001, default 3. */
  maxRetries?: number;
  /** Upper bound of the random pause between retries, default 500 ms. */
  jitterMaxMs?: number;
  /** Per-attempt application deadline, default 15 s. */
  attemptTimeoutMs?: number;
  /** Absolute deadline (epoch ms) after which no new attempt starts; default start + 70 s. */
  deadlineAt?: number;
}

const DEFAULTS = {
  lockTimeout: '5s',
  statementTimeout: '10s',
  maxRetries: 3,
  jitterMaxMs: 500,
  attemptTimeoutMs: 15_000,
  hardDeadlineMs: 70_000,
};

const INTERVAL = /^\d+(ms|s|min)$/;

function assertInterval(value: string): string {
  if (!INTERVAL.test(value)) throw new Error(`Invalid interval literal: ${value}`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(lockTimeoutError()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs a scenario in one database transaction (architecture 12.1): the first statements are
 * SET LOCAL lock_timeout/statement_timeout, deadlocks and serialization failures are retried
 * with jitter, lock timeouts become 503 LOCK_TIMEOUT. Nested calls join the active transaction.
 */
@Injectable()
export class TxRunner {
  constructor(
    @Inject(TransactionHost) private readonly host: TxHost,
    @Inject(ClsService) private readonly cls: ClsService,
    @Inject(TxHooks) private readonly hooks: TxHooks,
  ) {}

  /** The active transaction, or the plain database outside of one. */
  get tx(): Tx {
    return this.host.tx;
  }

  isActive(): boolean {
    return this.host.isTransactionActive();
  }

  run<T>(fn: () => Promise<T>, options: TxOptions = {}): Promise<T> {
    if (this.host.isTransactionActive()) return fn();
    if (!this.cls.isActive()) return this.cls.run(() => this.runAttempts(fn, options));
    return this.runAttempts(fn, options);
  }

  private async runAttempts<T>(fn: () => Promise<T>, options: TxOptions): Promise<T> {
    const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
    const deadline = options.deadlineAt ?? Date.now() + DEFAULTS.hardDeadlineMs;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.attempt(fn, options);
        await this.hooks.afterCommit();
        return result;
      } catch (error) {
        if (!isRetryableTxError(error)) throw this.translate(error);
        if (attempt >= maxRetries || Date.now() >= deadline) throw lockTimeoutError();
        await sleep(Math.random() * (options.jitterMaxMs ?? DEFAULTS.jitterMaxMs));
      }
    }
  }

  private attempt<T>(fn: () => Promise<T>, options: TxOptions): Promise<T> {
    const timeoutMs = options.attemptTimeoutMs ?? DEFAULTS.attemptTimeoutMs;
    return withTimeout(
      this.host.withTransaction(async () => {
        this.resetAttemptState();
        await this.setLocalTimeouts(options);
        const result = await fn();
        await this.hooks.beforeCommit(result);
        return result;
      }),
      timeoutMs,
    );
  }

  private resetAttemptState(): void {
    this.cls.set('lockLevel', 0);
    this.cls.set('outboxDirty', false);
    const idempotency = this.cls.get('idempotency');
    if (idempotency) idempotency.completedInTx = false;
  }

  private async setLocalTimeouts(options: TxOptions): Promise<void> {
    const lock = assertInterval(options.lockTimeout ?? DEFAULTS.lockTimeout);
    const statement = assertInterval(options.statementTimeout ?? DEFAULTS.statementTimeout);
    await this.host.tx.execute(sql.raw(`SET LOCAL lock_timeout = '${lock}'`));
    await this.host.tx.execute(sql.raw(`SET LOCAL statement_timeout = '${statement}'`));
  }

  private translate(error: unknown): unknown {
    return findPgError(error)?.code === PG_LOCK_NOT_AVAILABLE ? lockTimeoutError() : error;
  }
}
