import { Inject, Injectable } from '@nestjs/common';
import { asc, inArray, isNull, sql } from 'drizzle-orm';
import { Clock } from '../clock/clock.js';
import { outboxEvent } from '../db/schema/platform.js';
import { jobId } from '../queues/job-id.js';
import { QueuesService } from '../queues/queues.service.js';
import { TxRunner } from '../tx/tx-runner.js';
import { EventConsumers } from './event-consumers.js';
import { OUTBOX_BATCH, type OutboxEventData } from './outbox.types.js';

type OutboxRow = typeof outboxEvent.$inferSelect;

export function toEventData(row: OutboxRow): OutboxEventData {
  return {
    id: row.id,
    module: row.module,
    type: row.type,
    aggregateId: row.aggregateId,
    payload: row.payload as Record<string, unknown>,
    requestId: row.requestId,
  };
}

/**
 * Moves unpublished outbox rows into the BullMQ `events` queue (architecture 4). One short
 * transaction per batch: rows are claimed with FOR UPDATE SKIP LOCKED, so several workers never
 * handle the same row. Jobs use `<consumer>_<eventId>` ids, so a crash between enqueue and
 * commit only re-adds jobs that BullMQ deduplicates.
 */
@Injectable()
export class OutboxRelay {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(QueuesService) private readonly queues: QueuesService,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  /** Publishes one batch; returns the number of events marked as published. */
  runOnce(): Promise<number> {
    return this.tx.run(async () => {
      const rows = await this.tx.tx
        .select()
        .from(outboxEvent)
        .where(isNull(outboxEvent.publishedAt))
        .orderBy(asc(outboxEvent.id))
        .limit(OUTBOX_BATCH)
        .for('update', { skipLocked: true });
      if (rows.length === 0) return 0;
      for (const row of rows) await this.enqueue(toEventData(row));
      await this.tx.tx
        .update(outboxEvent)
        .set({ publishedAt: this.clock.now() })
        .where(
          inArray(
            outboxEvent.id,
            rows.map((r) => r.id),
          ),
        );
      return rows.length;
    });
  }

  private async enqueue(event: OutboxEventData): Promise<void> {
    for (const consumer of this.consumers.forEvent(event)) {
      await this.queues.add(
        'events',
        'deliver',
        { event, consumer: consumer.consumer, requestId: event.requestId ?? undefined },
        { jobId: jobId(consumer.consumer, event.id) },
      );
    }
  }

  /** Number of unpublished events, for metrics and tests. */
  async pendingCount(): Promise<number> {
    const rows = await this.tx.tx
      .select({ count: sql<number>`count(*)::int` })
      .from(outboxEvent)
      .where(isNull(outboxEvent.publishedAt));
    return rows[0]?.count ?? 0;
  }
}
