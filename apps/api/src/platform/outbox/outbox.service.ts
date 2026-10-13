import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import type { Redis } from 'ioredis';
import { uuidv7 } from 'uuidv7';
import { Clock } from '../clock/clock.js';
import { outboxEvent } from '../db/schema/platform.js';
import { InvariantError } from '../errors/domain-error.js';
import { REDIS } from '../redis/redis.module.js';
import { assertAttemptAlive } from '../tx/attempt.js';
import { TxHooks } from '../tx/tx-hooks.js';
import type { TxHost } from '../tx/tx-runner.js';
import { type NewOutboxEvent, OUTBOX_KICK_CHANNEL } from './outbox.types.js';

/** Writes events in the caller's transaction: no change without event, no event without change. */
@Injectable()
export class OutboxService implements OnModuleInit {
  constructor(
    @Inject(TransactionHost) private readonly txHost: TxHost,
    @Inject(ClsService) private readonly cls: ClsService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(TxHooks) private readonly hooks: TxHooks,
  ) {}

  onModuleInit(): void {
    this.hooks.register({ afterCommit: () => this.kickIfDirty() });
  }

  async publish(event: NewOutboxEvent): Promise<string> {
    const [id] = await this.publishMany([event]);
    return id as string;
  }

  /** Writes several events with one INSERT (no query per event); returns the ids in input order. */
  async publishMany(events: NewOutboxEvent[]): Promise<string[]> {
    if (!this.txHost.isTransactionActive()) {
      throw new InvariantError('Outbox events must be written inside a transaction');
    }
    assertAttemptAlive(this.cls);
    if (events.length === 0) return [];
    const requestId = this.cls.isActive() ? (this.cls.get('requestId') ?? null) : null;
    const createdAt = this.clock.now();
    const rows = events.map((event) => ({
      id: uuidv7(),
      module: event.module,
      type: event.type,
      aggregateId: event.aggregateId,
      payload: event.payload,
      requestId,
      createdAt,
    }));
    await this.txHost.tx.insert(outboxEvent).values(rows);
    this.cls.set('outboxDirty', true);
    return rows.map((row) => row.id);
  }

  /** Wakes the relay right after commit; polling every 250 ms is the fallback if this fails. */
  private async kickIfDirty(): Promise<void> {
    if (!this.cls.isActive() || this.cls.get('outboxDirty') !== true) return;
    this.cls.set('outboxDirty', false);
    try {
      await this.redis.publish(OUTBOX_KICK_CHANNEL, '1');
    } catch {
      // Best effort: the relay polls anyway.
    }
  }
}
