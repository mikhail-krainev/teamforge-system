import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { TransitionRepository } from '../repositories/transition.repository.js';

/**
 * FR-WORK-18, architecture 11.4: the deadline of the open stage moves by the time the team spent
 * suspended. Any status change of the team is a reason to look: the suspension time that is finished
 * and not yet in the stage's due date is added, once (conditional UPDATE, so a redelivery, a parallel
 * run or a change that did not end a suspension adds nothing). Runs inside the inbox transaction.
 */
@Injectable()
export class StageSuspensionConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'workspace.stage-suspension';
  readonly types = ['teams.team_status_changed'] as const;

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(TransitionRepository) private readonly transitions: TransitionRepository,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: OutboxEventData): Promise<void> {
    const { teamId } = event.payload;
    if (typeof teamId !== 'string') return;
    const team = await this.teams.getTeamView(teamId);
    if (team === null || team.suspendedTotalSeconds <= 0) return;
    await this.transitions.applySuspension(teamId, team.suspendedTotalSeconds);
  }
}
