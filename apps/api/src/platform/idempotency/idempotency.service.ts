import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import type { IdempotencyContext } from '../context/cls-store.js';
import { Clock } from '../clock/clock.js';
import { DomainError } from '../errors/domain-error.js';
import { toProblem } from '../errors/problem.js';
import { canonicalJson } from '../http/canonical-json.js';
import { TxHooks } from '../tx/tx-hooks.js';
import type { TxHost } from '../tx/tx-runner.js';
import { type KeyRow, IdempotencyStore } from './idempotency.store.js';

/** In-progress claim lifetime: longer than the 70 s worst case of a request (12.1, 12.4). */
export const LOCK_MS = 120_000;
/** C-50: stored responses live 24 h. */
export const TTL_MS = 24 * 60 * 60 * 1000;

export type BeginDecision =
  { kind: 'proceed'; lockToken: string } | { kind: 'replay'; status: number; body: unknown };

export interface BeginInput {
  userId: string;
  key: string;
  operationId: string;
  params: unknown;
  body: unknown;
}

export function requestHash(operationId: string, params: unknown, body: unknown): Buffer {
  const material = `${operationId}\n${canonicalJson(params ?? {})}\n${canonicalJson(body ?? null)}`;
  return createHash('sha256').update(material).digest();
}

function inProgress(): DomainError {
  return new DomainError('IDEMPOTENCY_IN_PROGRESS', 409, {
    retryAfterSeconds: 1,
    headers: { 'Retry-After': '1' },
  });
}

/** Algorithm of architecture 12.4. */
@Injectable()
export class IdempotencyService implements OnModuleInit {
  constructor(
    @Inject(IdempotencyStore) private readonly store: IdempotencyStore,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(ClsService) private readonly cls: ClsService,
    @Inject(TransactionHost) private readonly txHost: TxHost,
    @Inject(TxHooks) private readonly hooks: TxHooks,
  ) {}

  onModuleInit(): void {
    this.hooks.register({ beforeCommit: (result) => this.completeInTx(result) });
  }

  /** Steps 1-2: claim the key, or decide what to answer instead of executing. */
  async begin(input: BeginInput): Promise<BeginDecision> {
    const hash = requestHash(input.operationId, input.params, input.body);
    for (let round = 0; round < 3; round += 1) {
      const now = this.clock.now();
      const lockToken = await this.store.tryInsert({
        ...input,
        requestHash: hash,
        now,
        lockMs: LOCK_MS,
        ttlMs: TTL_MS,
      });
      if (lockToken !== undefined) return { kind: 'proceed', lockToken };
      const decision = await this.decideForExisting(input, hash, now);
      if (decision !== 'retry') return decision;
    }
    throw inProgress();
  }

  private async decideForExisting(
    input: BeginInput,
    hash: Buffer,
    now: Date,
  ): Promise<BeginDecision | 'retry'> {
    const row = await this.store.find(input.userId, input.key);
    if (row === undefined) return 'retry';
    if (row.expiresAt <= now) {
      await this.store.deleteExpired(input.userId, input.key, now);
      return 'retry';
    }
    if (row.operationId !== input.operationId || !row.requestHash.equals(hash)) {
      throw new DomainError('IDEMPOTENCY_KEY_REUSED', 422);
    }
    if (row.status === 'completed') return this.replayOf(row);
    if (row.lockedUntil > now) throw inProgress();
    const lockToken = await this.store.takeOver(input.userId, input.key, now, LOCK_MS);
    return lockToken === undefined ? 'retry' : { kind: 'proceed', lockToken };
  }

  private replayOf(row: KeyRow): BeginDecision {
    return { kind: 'replay', status: row.responseStatus ?? 200, body: row.responseBody };
  }

  /** Step 3: last statement of the business transaction. 0 rows = the claim was taken over. */
  private async completeInTx(result: unknown): Promise<void> {
    const ctx = this.cls.get('idempotency');
    if (ctx === undefined) return;
    const body = result === undefined ? null : JSON.parse(JSON.stringify(result));
    const done = await this.store.complete(this.txHost.tx, ctx, {
      status: ctx.successStatus,
      body,
    });
    if (!done) throw inProgress();
    ctx.completedInTx = true;
  }

  /** Handler finished without completing the key in a transaction (no database effect). */
  async afterSuccess(ctx: IdempotencyContext, value: unknown): Promise<void> {
    if (ctx.completedInTx) return;
    const body = value === undefined ? null : JSON.parse(JSON.stringify(value));
    await this.store.complete(this.txHost.tx, ctx, { status: ctx.successStatus, body });
  }

  /** Step 4: 4xx is stored as the answer; 5xx/503 releases the claim for a clean retry. */
  async afterFailure(
    ctx: IdempotencyContext,
    error: unknown,
    problemContext: { instance: string; requestId: string },
  ): Promise<void> {
    const problem = toProblem(error, problemContext);
    const stored = problem.status >= 400 && problem.status < 500 && !isFencingFailure(error);
    if (stored) {
      await this.store.complete(this.txHost.tx, ctx, {
        status: problem.status,
        body: problem.body,
      });
    } else if (!isFencingFailure(error)) {
      await this.store.release(ctx);
    }
  }

  deleteExpired(): Promise<number> {
    return this.store.deleteAllExpired(this.clock.now());
  }
}

function isFencingFailure(error: unknown): boolean {
  return error instanceof DomainError && error.code === 'IDEMPOTENCY_IN_PROGRESS';
}
