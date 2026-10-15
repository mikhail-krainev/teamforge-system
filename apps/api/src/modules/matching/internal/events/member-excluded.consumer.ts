import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { ApplicationRestoreService } from './application-restore.service.js';

/**
 * `matching.member-excluded`: `teams.member_excluded {teamId, userId, applicationId}` returns the
 * excluded person to the queue (FR-MATCH-08). An event without an application (a member who did
 * not come from the queue) has nothing to restore.
 */
@Injectable()
export class MemberExcludedConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'matching.member-excluded';
  readonly types = ['teams.member_excluded'] as const;

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(ApplicationRestoreService) private readonly restoring: ApplicationRestoreService,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: OutboxEventData): Promise<void> {
    const { teamId, userId, applicationId } = event.payload;
    if (typeof teamId !== 'string' || typeof userId !== 'string') return;
    if (typeof applicationId !== 'string') return;
    await this.restoring.restore({ teamId, userId, applicationId });
  }
}
