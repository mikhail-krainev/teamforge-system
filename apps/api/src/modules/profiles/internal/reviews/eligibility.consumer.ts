import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import type { CompletedProject } from '../../public.js';
import { EligibilityService } from './eligibility.service.js';

/** Reads `workspace.project_completed`; anything malformed is not a completion and is skipped. */
export function parseCompletion(payload: Record<string, unknown>): CompletedProject | undefined {
  const { teamId, teamName, completedAt, memberUserIds } = payload;
  const at = typeof completedAt === 'string' ? new Date(completedAt) : undefined;
  if (
    typeof teamId !== 'string' ||
    typeof teamName !== 'string' ||
    at === undefined ||
    Number.isNaN(at.getTime()) ||
    !Array.isArray(memberUserIds) ||
    !memberUserIds.every((id) => typeof id === 'string')
  ) {
    return undefined;
  }
  return { teamId, teamName, completedAt: at, memberUserIds: memberUserIds as string[] };
}

/**
 * `profiles.review-eligibility`: the completion of a project opens the review window of its
 * participants (C-27). Runs in the inbox transaction; `ON CONFLICT DO NOTHING` makes a repeat harmless.
 */
@Injectable()
export class ReviewEligibilityConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'profiles.review-eligibility';
  readonly types = ['workspace.project_completed'] as const;

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(EligibilityService) private readonly eligibility: EligibilityService,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: OutboxEventData): Promise<void> {
    const project = parseCompletion(event.payload);
    if (project !== undefined) await this.eligibility.record(project);
  }
}
