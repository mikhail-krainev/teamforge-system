import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { Clock } from '../clock/clock.js';
import { DB, type Database } from '../db/db.module.js';
import { eventDeadLetter } from '../db/schema/platform.js';
import { findPgError } from '../errors/pg-errors.js';
import { type JobProcessor, ProcessorRegistry } from '../queues/queue-workers.js';
import type { QueueJob } from '../queues/queues.service.js';
import { EventConsumers } from './event-consumers.js';
import { InboxService } from './inbox.service.js';
import type { OutboxEventData } from './outbox.types.js';

interface DeliveryData {
  event: OutboxEventData;
  consumer: string;
}

function delivery(job: QueueJob): DeliveryData {
  return job.data as unknown as DeliveryData;
}

/** BullMQ processor of the `events` queue: delivers one outbox event to one consumer. */
@Injectable()
export class EventsProcessor implements JobProcessor, OnModuleInit {
  readonly queue = 'events' as const;

  constructor(
    @Inject(ProcessorRegistry) private readonly registry: ProcessorRegistry,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(InboxService) private readonly inbox: InboxService,
    @Inject(DB) private readonly db: Database,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: QueueJob): Promise<boolean> {
    const { event, consumer: name } = delivery(job);
    const consumer = this.consumers.get(name);
    if (consumer === undefined) throw new Error(`No event consumer registered: ${name}`);
    return this.inbox.runOnce(name, event.id, () => consumer.handle(event));
  }

  /** Last attempt failed: park the event in platform.event_dead_letter until it is replayed. */
  async onExhausted(job: QueueJob, error: Error): Promise<void> {
    const { event, consumer } = delivery(job);
    const reason = [error.name, findPgError(error)?.code].filter(Boolean).join(' ');
    await this.db
      .insert(eventDeadLetter)
      .values({
        consumer,
        eventId: event.id,
        type: `${event.module}.${event.type}`,
        aggregateId: event.aggregateId,
        payload: event.payload,
        error: reason,
        attempts: job.attemptsMade,
        failedAt: this.clock.now(),
      })
      .onConflictDoUpdate({
        target: [eventDeadLetter.consumer, eventDeadLetter.eventId],
        set: {
          error: reason,
          attempts: job.attemptsMade,
          failedAt: this.clock.now(),
          replayedAt: null,
        },
      });
  }
}
