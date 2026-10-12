import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../clock/clock.js';
import { inboxEvent } from '../db/schema/platform.js';
import { TxRunner } from '../tx/tx-runner.js';

/** Consumer-side deduplication: at-least-once delivery becomes effectively-once per consumer. */
@Injectable()
export class InboxService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  /**
   * Runs `handler` once per (consumer, eventId): the inbox row and the handler's writes commit
   * together. A redelivery hits the primary key and is skipped. Returns whether it ran.
   */
  runOnce(consumer: string, eventId: string, handler: () => Promise<void>): Promise<boolean> {
    return this.tx.run(async () => {
      const inserted = await this.tx.tx
        .insert(inboxEvent)
        .values({ consumer, eventId, processedAt: this.clock.now() })
        .onConflictDoNothing()
        .returning({ eventId: inboxEvent.eventId });
      if (inserted.length === 0) return false;
      await handler();
      return true;
    });
  }
}
