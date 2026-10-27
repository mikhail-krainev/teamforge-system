import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { sql } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import type { Database } from '../db/db.module.js';
import { InvariantError, lockTimeoutError } from '../errors/domain-error.js';
import { findPgError, isRetryableTxError, PG_LOCK_NOT_AVAILABLE } from '../errors/pg-errors.js';
import { type AttemptState, assertAttemptAlive } from './attempt.js';
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

/**
 * Rejects with 503 LOCK_TIMEOUT when the attempt is still running after `ms`. The attempt is
 * marked aborted first, so that it rolls back instead of committing later; once it passed its last
 * check (`finishing`) the deadline is ignored and the real outcome is awaited.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, state: AttemptState): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (state.finishing) return;
      state.aborted = true;
      reject(lockTimeoutError());
    }, ms);
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
    assertAttemptAlive(this.cls);
    return this.host.tx;
  }

  isActive(): boolean {
    return this.host.isTransactionActive();
  }

  async run<T>(fn: () => Promise<T>, options: TxOptions = {}): Promise<T> {
    if (this.host.isTransactionActive()) return fn();
    this.assertOneTransactionPerOperation();
    if (!this.cls.isActive()) return this.cls.run(() => this.runAttempts(fn, options));
    return this.runAttempts(fn, options);
  }

  /**
   * Queues work for after the commit of the active transaction (at once outside one): a job that must not be seen
   * before the rows it reads are committed. A retried attempt drops what the failed attempt queued, a rollback
   * runs nothing. The work handles its own failures (the transaction is committed by then; a sweep repairs).
   */
  async afterCommit(work: () => Promise<void>): Promise<void> {
    const queue = this.host.isTransactionActive() ? this.cls.get('afterCommit') : undefined;
    if (queue === undefined) {
      await work();
      return;
    }
    // The array is the one of the attempt, made outside the transaction's own (inherited) CLS store: a `set`
    // inside that store would not be seen after the commit.
    queue.push(work);
  }

  private async runQueuedAfterCommit(queued: (() => Promise<void>)[]): Promise<void> {
    for (const work of queued.splice(0)) await work();
  }

  private async runAttempts<T>(fn: () => Promise<T>, options: TxOptions): Promise<T> {
    const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
    const deadline = options.deadlineAt ?? Date.now() + DEFAULTS.hardDeadlineMs;
    for (let attempt = 0; ; attempt += 1) {
      const queued: (() => Promise<void>)[] = [];
      this.cls.set('afterCommit', queued);
      try {
        const result = await this.attempt(fn, options);
        this.markCommitted();
        await this.hooks.afterCommit();
        await this.runQueuedAfterCommit(queued);
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
    const state: AttemptState = { aborted: false, finishing: false };
    return withTimeout(
      this.host.withTransaction(async () => {
        this.cls.set('attempt', state);
        this.resetAttemptState();
        await this.setLocalTimeouts(options);
        const result = await fn();
        assertAttemptAlive(this.cls);
        await this.hooks.beforeCommit(result);
        assertAttemptAlive(this.cls);
        state.finishing = true;
        return result;
      }),
      timeoutMs,
      state,
    );
  }

  /**
   * One mutating operation = one business transaction (architecture 12.4). The idempotency key is
   * completed as the last statement of the first transaction that commits under it, so a second
   * top-level transaction in the same request would run with a key that already says "done": a
   * retry could never complete the operation. Refused in every environment (S1R-02).
   */
  private assertOneTransactionPerOperation(): void {
    if (this.cls.isActive() && this.cls.get('idempotency')?.committed === true) {
      throw new InvariantError(
        'A second top-level transaction under one Idempotency-Key: an operation must use exactly one transaction',
      );
    }
  }

  private markCommitted(): void {
    const idempotency = this.cls.isActive() ? this.cls.get('idempotency') : undefined;
    if (idempotency) idempotency.committed = true;
  }

  private resetAttemptState(): void {
    this.cls.set('lockLevel', 0);
    this.cls.set('lockedUsers', {});
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
