import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { ServerEventMessage } from 'shared/realtime';
import { Clock } from '../../../../platform/clock/clock.js';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { REDIS } from '../../../../platform/redis/redis.module.js';
import { REALTIME_SOURCES, realtimeSignals } from '../domain/realtime-events.js';

/** Redis pub/sub prefix shared with the gateway: `rt:team:<id>` and `rt:user:<id>`. */
export const REALTIME_PREFIX = 'rt:';

/**
 * Outbox relay of realtime signals (ADR-0011): publishes `rt:<channel>` for the gateway of every
 * api instance. Publishing is at-least-once and the signal says only "re-read"; a duplicate or a
 * lost message costs one extra or one missed refetch, never data.
 */
@Injectable()
export class RealtimeRelayConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'workspace.realtime';
  readonly types = REALTIME_SOURCES;

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: OutboxEventData): Promise<void> {
    const at = this.clock.now().toISOString();
    for (const signal of realtimeSignals({
      name: `${event.module}.${event.type}`,
      payload: event.payload,
    })) {
      const message = { op: 'event', at, ...signal } as ServerEventMessage;
      await this.redis.publish(`${REALTIME_PREFIX}${signal.channel}`, JSON.stringify(message));
    }
  }
}
