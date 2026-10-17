import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import {
  PLAYBOOKS_API,
  type PlaybooksApi,
  type StepDefinition,
} from '../../../playbooks/public.js';
import {
  TEAMS_API,
  type TeamId,
  type TeamLifecyclePort,
  type TeamsApi,
} from '../../../teams/public.js';
import { WORKSPACE_MODULE } from '../../public.js';
import { chooseExecutor, stageDueAt, type RoleHolder } from '../domain/route-plan.js';
import { RouteRepository } from '../repositories/route.repository.js';
import type { checklistItem } from '../schema/stage.js';

type ItemInsert = typeof checklistItem.$inferInsert;

/** The checklist row of a step for the given roster (FR-WORK-01, -02). */
export function itemRowOf(
  teamId: TeamId,
  stageId: string,
  step: StepDefinition,
  members: readonly RoleHolder[],
  now: Date,
): ItemInsert {
  const executor = chooseExecutor(step, members);
  return {
    id: uuidv7(),
    teamId,
    projectStageId: stageId,
    stepKey: step.key,
    kind: step.kind,
    submission: step.submission,
    ritualKind: step.ritualKind,
    required: step.required,
    ownerRole: step.ownerRole,
    altRoles: step.altRoles,
    status: 'open',
    assigneeUserId: executor.assigneeUserId,
    roleCode: executor.roleCode,
    fallbackUsed: executor.fallbackUsed,
    version: 1,
    updatedAt: now,
  };
}

/**
 * `TeamLifecyclePort` of workspace (FR-WORK-01): called by teams inside the start transaction (T4,
 * the team is locked). Plans every stage of the pinned playbook, opens stage 1 and creates its
 * checklist; the items of the later stages are created when the stage opens (S5-10).
 */
@Injectable()
export class TeamLifecycleService implements TeamLifecyclePort {
  constructor(
    @Inject(PLAYBOOKS_API) private readonly playbooks: PlaybooksApi,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(RouteRepository) private readonly route: RouteRepository,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async onProjectStarted(input: {
    teamId: TeamId;
    playbookId: string;
    startedAt: Date;
  }): Promise<void> {
    const definition = await this.playbooks.getDefinition(input.playbookId);
    const stages = [...definition.stages].sort((a, b) => a.ordinal - b.ordinal);
    const first = stages[0];
    if (first === undefined) return;
    const roster = await this.teams.getRoster(input.teamId);
    const members: RoleHolder[] = roster.map((m) => ({
      userId: m.userId,
      roles: m.roles.map((r) => r.roleCode),
    }));
    const ids = new Map(stages.map((s) => [s.ordinal, uuidv7()]));
    await this.route.insertStages(
      stages.map((s) => {
        const open = s.ordinal === first.ordinal;
        return {
          id: ids.get(s.ordinal) ?? uuidv7(),
          teamId: input.teamId,
          stageKey: s.key,
          ordinal: s.ordinal,
          title: s.title,
          durationDays: s.durationDays,
          status: open ? 'open' : 'pending',
          openedAt: open ? input.startedAt : null,
          dueAt: open ? stageDueAt(input.startedAt, s.durationDays) : null,
          version: 1,
        };
      }),
    );
    const firstId = ids.get(first.ordinal);
    if (firstId === undefined) return;
    await this.route.insertItems(
      [...first.steps]
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((step) => itemRowOf(input.teamId, firstId, step, members, input.startedAt)),
    );
    // Architecture 4: stage 1 opens with the project, like every later stage opens with a transition.
    await this.outbox.publish({
      module: WORKSPACE_MODULE,
      type: 'stage_opened',
      aggregateId: firstId,
      payload: { teamId: input.teamId, stageId: firstId, ordinal: first.ordinal },
    });
  }
}
