import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lt } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module.js';
import { idempotencyKey } from '../db/schema/platform.js';

export type KeyRow = typeof idempotencyKey.$inferSelect;

export interface AcquireInput {
  userId: string;
  key: string;
  operationId: string;
  requestHash: Buffer;
  now: Date;
  lockMs: number;
  ttlMs: number;
}

export interface ResponseRecord {
  status: number;
  body: unknown;
  /** True when body is the raw result of the business transaction, not the final HTTP body. */
  provisional?: boolean;
}

/**
 * SQL for platform.idempotency_key. Acquire/takeover/delete run OUTSIDE business transactions
 * (plain pool connection); `complete` takes the transaction as an argument and is called as the
 * last statement of the business transaction (architecture 12.4).
 */
@Injectable()
export class IdempotencyStore {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** INSERT ... ON CONFLICT DO NOTHING RETURNING: the lock token when this request owns the key. */
  async tryInsert(input: AcquireInput): Promise<string | undefined> {
    const lockToken = randomUUID();
    const rows = await this.db
      .insert(idempotencyKey)
      .values({
        userId: input.userId,
        key: input.key,
        operationId: input.operationId,
        requestHash: input.requestHash,
        status: 'in_progress',
        lockedUntil: new Date(input.now.getTime() + input.lockMs),
        lockToken,
        createdAt: input.now,
        expiresAt: new Date(input.now.getTime() + input.ttlMs),
      })
      .onConflictDoNothing({ target: [idempotencyKey.userId, idempotencyKey.key] })
      .returning({ lockToken: idempotencyKey.lockToken });
    return rows[0]?.lockToken;
  }

  async find(userId: string, key: string): Promise<KeyRow | undefined> {
    const rows = await this.db
      .select()
      .from(idempotencyKey)
      .where(and(eq(idempotencyKey.userId, userId), eq(idempotencyKey.key, key)));
    return rows[0];
  }

  /** Takes over an expired in_progress claim; returns the new fencing token or undefined. */
  async takeOver(
    userId: string,
    key: string,
    now: Date,
    lockMs: number,
  ): Promise<string | undefined> {
    const lockToken = randomUUID();
    const rows = await this.db
      .update(idempotencyKey)
      .set({ lockToken, lockedUntil: new Date(now.getTime() + lockMs) })
      .where(
        and(
          eq(idempotencyKey.userId, userId),
          eq(idempotencyKey.key, key),
          eq(idempotencyKey.status, 'in_progress'),
          lt(idempotencyKey.lockedUntil, now),
        ),
      )
      .returning({ lockToken: idempotencyKey.lockToken });
    return rows[0]?.lockToken;
  }

  /** Completes the key if the fencing token still matches. Returns false when it does not. */
  async complete(
    executor: Database,
    ref: { userId: string; key: string; lockToken: string },
    response: ResponseRecord,
  ): Promise<boolean> {
    const rows = await executor
      .update(idempotencyKey)
      .set({
        status: 'completed',
        responseStatus: response.status,
        responseBody: response.body ?? null,
        responseProvisional: response.provisional ?? false,
      })
      .where(
        and(
          eq(idempotencyKey.userId, ref.userId),
          eq(idempotencyKey.key, ref.key),
          eq(idempotencyKey.status, 'in_progress'),
          eq(idempotencyKey.lockToken, ref.lockToken),
        ),
      )
      .returning({ key: idempotencyKey.key });
    return rows.length === 1;
  }

  /**
   * Replaces the stored response of a key that this request completed (same fencing token):
   * the final HTTP body instead of the provisional transaction result. Clears the provisional mark
   * in the same statement, so a replay sees either the raw result with the mark or the final body.
   */
  async overwriteResponse(
    ref: { userId: string; key: string; lockToken: string },
    response: ResponseRecord,
  ): Promise<boolean> {
    const rows = await this.db
      .update(idempotencyKey)
      .set({
        responseStatus: response.status,
        responseBody: response.body ?? null,
        responseProvisional: false,
      })
      .where(
        and(
          eq(idempotencyKey.userId, ref.userId),
          eq(idempotencyKey.key, ref.key),
          eq(idempotencyKey.status, 'completed'),
          eq(idempotencyKey.lockToken, ref.lockToken),
        ),
      )
      .returning({ key: idempotencyKey.key });
    return rows.length === 1;
  }

  /** Releases a claim after a 5xx/503 so that a retry executes the operation again. */
  async release(ref: { userId: string; key: string; lockToken: string }): Promise<void> {
    await this.db
      .delete(idempotencyKey)
      .where(
        and(
          eq(idempotencyKey.userId, ref.userId),
          eq(idempotencyKey.key, ref.key),
          eq(idempotencyKey.status, 'in_progress'),
          eq(idempotencyKey.lockToken, ref.lockToken),
        ),
      );
  }

  /** Removes a stale completed row that outlived its TTL so the key can be reused. */
  async deleteExpired(userId: string, key: string, now: Date): Promise<void> {
    await this.db
      .delete(idempotencyKey)
      .where(
        and(
          eq(idempotencyKey.userId, userId),
          eq(idempotencyKey.key, key),
          lt(idempotencyKey.expiresAt, now),
        ),
      );
  }

  /** Hourly cleanup (`idempotency-cleanup`): drops rows past their 24 h TTL. */
  async deleteAllExpired(now: Date): Promise<number> {
    const rows = await this.db
      .delete(idempotencyKey)
      .where(lt(idempotencyKey.expiresAt, now))
      .returning({ key: idempotencyKey.key });
    return rows.length;
  }
}
