import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer } from '../../../../platform/outbox/outbox.types.js';
import { AutoAddScheduler } from '../services/auto-add-scheduler.service.js';

/** Events after which a pair may have become possible (architecture 6.4). */
export const AUTO_ADD_TRIGGERS = ['teams.seat_opened', 'matching.application_changed'] as const;

/**
 * `matching.auto-add-triggers`: a new open seat or a changed application schedules an extra
 * `matching-auto-add` run 5 s later (deduplicated per minute window). The run reads the state
 * itself, so a lost or repeated event costs nothing.
 */
@Injectable()
export class AutoAddEventsConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'matching.auto-add-triggers';
  readonly types = AUTO_ADD_TRIGGERS;

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(AutoAddScheduler) private readonly scheduler: AutoAddScheduler,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  handle(): Promise<void> {
    return this.scheduler.schedule();
  }
}
