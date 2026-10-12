import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lte, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { deletionLog, deletionRequest, deletionStep } from '../schema/auth.js';

export type DeletionRow = typeof deletionRequest.$inferSelect;

/** `DeletionRequest` of the contract. */
export interface DeletionDto {
  id: string;
  status: DeletionRow['status'];
  requestedAt: string;
  scheduledAt: string;
  deadlineAt: string;
}

export function toDeletionDto(row: DeletionRow): DeletionDto {
  return {
    id: row.id,
    status: row.status as DeletionDto['status'],
    requestedAt: row.requestedAt.toISOString(),
    scheduledAt: row.scheduledAt.toISOString(),
    deadlineAt: row.deadlineAt.toISOString(),
  };
}

/** SQL of the deletion tables (`deletion_request`, `deletion_step`, `deletion_log`). */
@Injectable()
export class DeletionRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  async insert(row: typeof deletionRequest.$inferInsert): Promise<DeletionRow> {
    const rows = await this.tx.tx.insert(deletionRequest).values(row).returning();
    return rows[0] as DeletionRow;
  }

  async openOf(userId: string): Promise<DeletionRow | undefined> {
    const rows = await this.tx.tx
      .select()
      .from(deletionRequest)
      .where(
        and(
          eq(deletionRequest.userId, userId),
          sql`${deletionRequest.status} IN ('requested','in_progress')`,
        ),
      );
    return rows[0];
  }

  /** Locks the request that was given this cancel token (hash), whatever its state. */
  async lockByCancelHash(hash: Buffer): Promise<DeletionRow | undefined> {
    const rows = await this.tx.tx
      .select()
      .from(deletionRequest)
      .where(eq(deletionRequest.cancelTokenHash, hash))
      .for('update');
    return rows[0];
  }

  async markCancelled(id: string, at: Date): Promise<DeletionRow> {
    const rows = await this.tx.tx
      .update(deletionRequest)
      .set({ status: 'cancelled', cancelledAt: at })
      .where(eq(deletionRequest.id, id))
      .returning();
    return rows[0] as DeletionRow;
  }

  /** Requests whose 72 hours are over, locked so that parallel schedulers split them. */
  async dueRequests(now: Date, limit: number): Promise<DeletionRow[]> {
    return this.tx.tx
      .select()
      .from(deletionRequest)
      .where(and(eq(deletionRequest.status, 'requested'), lte(deletionRequest.scheduledAt, now)))
      .orderBy(deletionRequest.scheduledAt)
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  /** requested -> in_progress; the cancel token stops working (architecture 13.9, step 1). */
  async start(id: string): Promise<void> {
    await this.tx.tx
      .update(deletionRequest)
      .set({ status: 'in_progress', cancelTokenHash: null })
      .where(eq(deletionRequest.id, id));
  }

  async findById(id: string): Promise<DeletionRow | undefined> {
    const rows = await this.tx.tx.select().from(deletionRequest).where(eq(deletionRequest.id, id));
    return rows[0];
  }

  /** Records that a module finished its step; false when it had already reported. */
  async addStep(requestId: string, module: string, at: Date): Promise<boolean> {
    const rows = await this.tx.tx
      .insert(deletionStep)
      .values({ requestId, module, doneAt: at })
      .onConflictDoNothing()
      .returning({ module: deletionStep.module });
    return rows.length > 0;
  }

  async reportedModules(requestId: string): Promise<string[]> {
    const rows = await this.tx.tx
      .select({ module: deletionStep.module })
      .from(deletionStep)
      .where(eq(deletionStep.requestId, requestId));
    return rows.map((row) => row.module);
  }

  /** The journal holds counters only, never personal data (FR-AUTH-09 (e)). */
  async log(
    entry: { id: string; requestId: string; module: string; action: string },
    counts: Record<string, number>,
    at: Date,
  ): Promise<void> {
    await this.tx.tx.insert(deletionLog).values({ ...entry, counts, at });
  }

  /** in_progress -> completed; false when another run completed it already. */
  async complete(id: string, at: Date): Promise<boolean> {
    const rows = await this.tx.tx
      .update(deletionRequest)
      .set({ status: 'completed', completedAt: at, cancelTokenHash: null })
      .where(and(eq(deletionRequest.id, id), eq(deletionRequest.status, 'in_progress')))
      .returning({ id: deletionRequest.id });
    return rows.length > 0;
  }
}
