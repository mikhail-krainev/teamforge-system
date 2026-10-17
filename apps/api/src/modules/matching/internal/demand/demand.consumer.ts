import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { DemandCache } from './demand-cache.js';

/** Events that name the role they concern in `payload.roleCode`. */
const ROLE_EVENTS = ['teams.seat_opened', 'teams.seat_closed', 'teams.member_joined'];
/** Events whose effect on the showcase is not tied to one role in the payload. */
const GENERAL_EVENTS = [
  'teams.member_left',
  'teams.member_excluded',
  'teams.team_status_changed',
  'matching.application_changed',
];

/**
 * Keeps the demand showcase fresh (FR-MATCH-09): a change of seats, members or queue drops the
 * cached rows, and the next read recounts. Re-reading and dropping is idempotent, so a repeated
 * delivery is harmless.
 */
@Injectable()
export class DemandCacheConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'matching.demand-cache';
  readonly types = [...ROLE_EVENTS, ...GENERAL_EVENTS];

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(DemandCache) private readonly cache: DemandCache,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: OutboxEventData): Promise<void> {
    const roleCode = event.payload['roleCode'];
    if (ROLE_EVENTS.includes(`${event.module}.${event.type}`) && typeof roleCode === 'string') {
      await this.cache.invalidate([roleCode]);
      return;
    }
    await this.cache.invalidateAll();
  }
}
