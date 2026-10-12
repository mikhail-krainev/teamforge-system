import { Injectable } from '@nestjs/common';
import type { EventConsumer, OutboxEventData } from './outbox.types.js';

/** Registry of module subscriptions to outbox events. */
@Injectable()
export class EventConsumers {
  private readonly consumers = new Map<string, EventConsumer>();

  register(consumer: EventConsumer): void {
    if (this.consumers.has(consumer.consumer)) {
      throw new Error(`Event consumer ${consumer.consumer} is already registered`);
    }
    this.consumers.set(consumer.consumer, consumer);
  }

  get(name: string): EventConsumer | undefined {
    return this.consumers.get(name);
  }

  /** Consumers subscribed to the event (`module.type` or `*`). */
  forEvent(event: Pick<OutboxEventData, 'module' | 'type'>): EventConsumer[] {
    const fullType = `${event.module}.${event.type}`;
    return [...this.consumers.values()].filter(
      (c) => c.types.includes('*') || c.types.includes(fullType),
    );
  }
}
