import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { outboxEvent } from '../db/schema/platform.js';
import { TxRunner } from '../tx/tx-runner.js';
import { EventConsumers } from './event-consumers.js';
import { InboxService } from './inbox.service.js';
import { toEventData } from './outbox-relay.js';

/**
 * Delivers events that a job has just committed to their consumers right away, instead of waiting for
 * the relay, the queue and a worker (about a tenth of a second). The events stay in the outbox: the relay
 * publishes them as usual and the inbox (`consumer`, `event_id`) makes the second delivery a no-op,
 * whoever comes first. A job that has to leave its work visible to the next reader (a webhook
 * is `processed` only once its contributions exist) calls this before it says it is done.
 * A failing consumer is only logged: the relay delivers the event again with the usual retries.
 */
@Injectable()
export class InlineDelivery {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(InboxService) private readonly inbox: InboxService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  /** Call after the transaction that wrote the events has committed. */
  async deliver(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    const rows = await this.tx.tx
      .select()
      .from(outboxEvent)
      .where(inArray(outboxEvent.id, eventIds))
      .orderBy(outboxEvent.id);
    for (const row of rows) {
      const event = toEventData(row);
      for (const consumer of this.consumers.forEvent(event)) {
        try {
          await this.inbox.runOnce(consumer.consumer, event.id, () => consumer.handle(event));
        } catch (error) {
          this.logger.warn(
            { err: error, consumer: consumer.consumer, event_id: event.id },
            'inline delivery failed, the relay will retry',
          );
        }
      }
    }
  }
}
