import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { outboxEvent } from '../db/schema/platform.js';
import { InvariantError } from '../errors/domain-error.js';
import { TxRunner } from '../tx/tx-runner.js';
import { EventConsumers } from './event-consumers.js';
import { InboxService } from './inbox.service.js';
import { toEventData } from './outbox-relay.js';

/**
 * Delivers events to their consumers inside the transaction that wrote them, instead of waiting for the
 * relay, the queue and a worker (about a tenth of a second). The events stay in the outbox: the relay
 * publishes them as usual, and the inbox row (`consumer`, `event_id`) that commits together with the
 * consumer's writes makes that second delivery a no-op. A job whose result must be complete for the next
 * reader (a webhook is `processed` only when its contributions exist, and the two appear at the same
 * moment) calls this before it commits. A failing consumer fails the transaction: nothing of it is kept
 * and the job is retried.
 */
@Injectable()
export class InlineDelivery {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(InboxService) private readonly inbox: InboxService,
  ) {}

  /** Call inside the transaction that wrote the events. */
  async deliver(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    if (!this.tx.isActive()) {
      throw new InvariantError(
        'Inline delivery must run inside the transaction that wrote the events',
      );
    }
    const rows = await this.tx.tx
      .select()
      .from(outboxEvent)
      .where(inArray(outboxEvent.id, eventIds))
      .orderBy(outboxEvent.id);
    for (const row of rows) {
      const event = toEventData(row);
      for (const consumer of this.consumers.forEvent(event)) {
        await this.inbox.runOnce(consumer.consumer, event.id, () => consumer.handle(event));
      }
    }
  }
}
