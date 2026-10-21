import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { CreditRunService } from '../services/credit-run.service.js';

/**
 * `rewards.credit-run`: `workspace.project_completed` opens the `credit_run` (status `cooling`, `cooling_until`
 * = completion + 7 days), runs the anti-fraud of the phase `completion` and schedules the timer of the end of the
 * cooling (architecture 10.1). The event is only the reason: the run is made from the snapshot of the completion,
 * and a second delivery or the scanner `credit-run-scan` finds the run there already and changes nothing.
 */
@Injectable()
export class CompletionConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'rewards.credit-run';
  readonly types = ['workspace.project_completed'] as const;

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(CreditRunService) private readonly runs: CreditRunService,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: OutboxEventData): Promise<void> {
    const teamId = event.payload['teamId'];
    if (typeof teamId !== 'string') return;
    await this.runs.open(teamId);
  }
}
