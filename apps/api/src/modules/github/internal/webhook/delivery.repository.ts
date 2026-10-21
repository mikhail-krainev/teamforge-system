import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { webhookDelivery } from '../schema/webhook.js';

export type DeliveryRow = typeof webhookDelivery.$inferSelect;
export type DeliveryStatus = DeliveryRow['status'];

export interface NewDelivery {
  deliveryId: string;
  event: string;
  action: string | null;
  installationId: number | null;
  repositoryId: number | null;
  /** `null` for a delivery that is stored as ignored: nothing of it is kept. */
  payload: Record<string, unknown> | null;
  status: 'received' | 'ignored';
  receivedAt: Date;
}

/** `github.webhook_delivery`: one row per `X-GitHub-Delivery` (FR-GH-04, CC-11). */
@Injectable()
export class DeliveryRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** `true` when the row is new; `false` for a repeated delivery (the primary key decides, CC-11). */
  async insert(delivery: NewDelivery): Promise<boolean> {
    const rows = await this.tx.tx
      .insert(webhookDelivery)
      .values({
        ...delivery,
        processedAt: delivery.status === 'ignored' ? delivery.receivedAt : null,
      })
      .onConflictDoNothing({ target: webhookDelivery.deliveryId })
      .returning({ deliveryId: webhookDelivery.deliveryId });
    return rows.length === 1;
  }

  async find(deliveryId: string): Promise<DeliveryRow | undefined> {
    const [row] = await this.tx.tx
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.deliveryId, deliveryId))
      .limit(1);
    return row;
  }

  /** Locks the row for the transaction that applies the delivery: a second worker waits and then sees the outcome. */
  async lock(deliveryId: string): Promise<DeliveryRow | undefined> {
    const [row] = await this.tx.tx
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.deliveryId, deliveryId))
      .limit(1)
      .for('update');
    return row;
  }

  async countAttempt(deliveryId: string): Promise<void> {
    await this.tx.tx
      .update(webhookDelivery)
      .set({ attempts: sql`${webhookDelivery.attempts} + 1` })
      .where(
        and(eq(webhookDelivery.deliveryId, deliveryId), eq(webhookDelivery.status, 'received')),
      );
  }

  /** Final state. The payload is dropped unless the delivery failed after its retries (kept for the investigation). */
  async finish(
    deliveryId: string,
    status: Exclude<DeliveryStatus, 'received'>,
    at: Date,
    options: { keepPayload?: boolean } = {},
  ): Promise<void> {
    await this.tx.tx
      .update(webhookDelivery)
      .set({
        status,
        processedAt: at,
        ...(options.keepPayload === true ? {} : { payload: null }),
      })
      .where(
        and(eq(webhookDelivery.deliveryId, deliveryId), eq(webhookDelivery.status, 'received')),
      );
  }

  /** Deliveries stored `received` before `before` (the process died between the insert and the queue). */
  async receivedBefore(before: Date, limit: number): Promise<DeliveryRow[]> {
    return this.tx.tx
      .select()
      .from(webhookDelivery)
      .where(and(eq(webhookDelivery.status, 'received'), lt(webhookDelivery.receivedAt, before)))
      .orderBy(webhookDelivery.receivedAt)
      .limit(limit);
  }

  /** Retention (C-56): handled deliveries older than the cut-off go. Returns how many. */
  async deleteOlderThan(before: Date): Promise<number> {
    const rows = await this.tx.tx
      .delete(webhookDelivery)
      .where(lt(webhookDelivery.receivedAt, before))
      .returning({ deliveryId: webhookDelivery.deliveryId });
    return rows.length;
  }
}
