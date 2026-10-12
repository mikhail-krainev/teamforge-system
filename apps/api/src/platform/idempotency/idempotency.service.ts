import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import type { IdempotencyContext } from '../context/cls-store.js';
import { Clock } from '../clock/clock.js';
import { DomainError } from '../errors/domain-error.js';
import { type ProblemResult, toProblem } from '../errors/problem.js';
import { canonicalJson } from '../http/canonical-json.js';
import { TxHooks } from '../tx/tx-hooks.js';
import type { TxHost } from '../tx/tx-runner.js';
import { type KeyRow, IdempotencyStore, type ResponseRecord } from './idempotency.store.js';

/** In-progress claim lifetime: longer than the 70 s worst case of a request (12.1, 12.4). */
export const LOCK_MS = 120_000;
/** Attempts to replace the provisional response with the final body, and the pause before each retry. */
export const FINALIZE_ATTEMPTS = 3;
export const FINALIZE_RETRY_MS = 100;
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
    @Inject(PinoLogger) private readonly logger: PinoLogger,
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
    // The business transaction committed but the final HTTP body is not stored yet: the raw
    // transaction result must never reach a client. Answer "in progress" until it is replaced.
    if (row.status === 'completed' && row.responseProvisional) throw inProgress();
    if (row.status === 'completed') return this.replayOf(row);
    if (row.lockedUntil > now) throw inProgress();
    const lockToken = await this.store.takeOver(input.userId, input.key, now, LOCK_MS);
    return lockToken === undefined ? 'retry' : { kind: 'proceed', lockToken };
  }

  private replayOf(row: KeyRow): BeginDecision {
    return { kind: 'replay', status: row.responseStatus ?? 200, body: row.responseBody };
  }

  /**
   * Step 3: last statement of the business transaction. 0 rows = the claim was taken over. The
   * transaction result is a PROVISIONAL response (the row is marked `response_provisional`): it
   * makes "effect without a stored answer" impossible; the interceptor replaces it with the final
   * HTTP body (`afterSuccess`). Until then a repeated request gets 409 IDEMPOTENCY_IN_PROGRESS.
   */
  private async completeInTx(result: unknown): Promise<void> {
    const ctx = this.cls.get('idempotency');
    if (ctx === undefined) return;
    const body = toJson(result);
    const done = await this.store.complete(this.txHost.tx, ctx, {
      status: ctx.successStatus,
      body,
      provisional: true,
    });
    if (!done) throw inProgress();
    ctx.completedInTx = true;
  }

  /**
   * The handler produced its final response. A key already completed in the business transaction
   * gets the body the client really receives (the controller may reshape the transaction result);
   * a handler without database effect completes the key here.
   */
  async afterSuccess(ctx: IdempotencyContext, value: unknown): Promise<void> {
    const body = toJson(value);
    if (!ctx.completedInTx) {
      await this.store.complete(this.txHost.tx, ctx, { status: ctx.successStatus, body });
      return;
    }
    await this.finalizeResponse(ctx, { status: ctx.successStatus, body });
  }

  /**
   * Replaces the provisional response, repeating the write when it fails: the effect is committed,
   * so the client still gets its success answer. If every attempt fails the row stays provisional
   * and repeated requests keep getting 409 IDEMPOTENCY_IN_PROGRESS until the key expires; the raw
   * result is never replayed.
   */
  private async finalizeResponse(ctx: IdempotencyContext, response: ResponseRecord): Promise<void> {
    for (let attempt = 1; attempt <= FINALIZE_ATTEMPTS; attempt += 1) {
      try {
        await this.store.overwriteResponse(ctx, response);
        return;
      } catch (error) {
        this.logger.warn({ err: error, attempt }, 'idempotency: final response write failed');
        if (attempt < FINALIZE_ATTEMPTS) await pause(FINALIZE_RETRY_MS * attempt);
      }
    }
    this.logger.error('idempotency: key left with a provisional response');
  }

  /**
   * Step 4: a definitive 4xx is stored as the answer; temporary answers (408, 423, 425, 429, any
   * response with Retry-After, 5xx, LOCK_TIMEOUT) release the claim so that a retry with the same
   * key executes the operation (the client keeps the key for exactly these answers).
   * Once the business transaction committed nothing is released or replaced: the effect exists,
   * the key keeps the stored response and a retry replays it (no double effect).
   */
  async afterFailure(
    ctx: IdempotencyContext,
    error: unknown,
    problemContext: { instance: string; requestId: string },
  ): Promise<void> {
    if (ctx.committed || isFencingFailure(error)) return;
    const problem = toProblem(error, problemContext);
    if (isDefinitiveRejection(problem)) {
      await this.store.complete(this.txHost.tx, ctx, {
        status: problem.status,
        body: problem.body,
      });
    } else {
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

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function toJson(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/** Statuses that tell the client to try again later: never stored as the final answer. */
const TEMPORARY_STATUSES = new Set([408, 423, 425, 429]);

function isDefinitiveRejection(problem: ProblemResult): boolean {
  if (problem.status < 400 || problem.status >= 500) return false;
  if (TEMPORARY_STATUSES.has(problem.status)) return false;
  return !Object.keys(problem.headers).some((name) => name.toLowerCase() === 'retry-after');
}
