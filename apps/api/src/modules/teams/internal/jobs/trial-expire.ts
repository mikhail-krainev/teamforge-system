import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { jobId } from '../../../../platform/queues/job-id.js';
import { QueuesService } from '../../../../platform/queues/queues.service.js';
import { TrialRepository } from '../repositories/trial.repository.js';

export const TRIAL_EXPIRE_JOB = 'trial-expire';

/** Reads `{ membershipId }` of a `trial-expire` job. */
export function parseTrialExpire(data: unknown): string {
  const { membershipId } = (data ?? {}) as { membershipId?: unknown };
  if (typeof membershipId !== 'string') throw new Error('trial-expire needs a membershipId');
  return membershipId;
}

/**
 * `teams.trial-timer`: an auto-added member (`teams.member_joined` with `via = auto` and a
 * `trialUntil`) gets a delayed `trial-expire` job for the end of the trial (FR-TEAM-24). The job
 * id is deterministic, so a repeated delivery adds nothing; a failure to reach Redis is thrown,
 * and the outbox delivers the event again.
 */
@Injectable()
export class TrialExpireScheduler implements EventConsumer, OnModuleInit {
  readonly consumer = 'teams.trial-timer';
  readonly types = ['teams.member_joined'] as const;

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(QueuesService) private readonly queues: QueuesService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(TrialRepository) private readonly trials: TrialRepository,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: OutboxEventData): Promise<void> {
    const { teamId, userId, via, trialUntil } = event.payload;
    if (via !== 'auto' || typeof trialUntil !== 'string') return;
    if (typeof teamId !== 'string' || typeof userId !== 'string') return;
    const member = await this.trials.findActive(teamId, userId);
    if (member === undefined) return;
    const dueAt = Date.parse(trialUntil);
    await this.queues.add(
      'timers',
      TRIAL_EXPIRE_JOB,
      { membershipId: member.id },
      {
        jobId: jobId('trialexpire', member.id, 'due'),
        delayMs: Math.max(0, dueAt - this.clock.now().getTime()),
      },
    );
  }
}
