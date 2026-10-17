import { Inject, Injectable } from '@nestjs/common';
import type { Body, Ok } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { LockService } from '../../../../platform/tx/locks.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { PLAYBOOKS_API, type PlaybooksApi } from '../../../playbooks/public.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { WORKSPACE_MODULE } from '../../public.js';
import { stageDueAt, type RoleHolder } from '../domain/route-plan.js';
import { nextOrdinal, unmetConditions } from '../domain/transition-rules.js';
import { ItemRepository } from '../repositories/item.repository.js';
import { RouteRepository } from '../repositories/route.repository.js';
import { TransitionRepository } from '../repositories/transition.repository.js';
import { assertTeamWritable } from './item-gate.js';
import { ReviewService } from './review.service.js';
import { itemRowOf } from './team-lifecycle.service.js';

/** `project_stage.ordinal` is a smallint: a larger number cannot exist. */
const MAX_ORDINAL = 32_767;

type PlaybookId = Parameters<PlaybooksApi['getDefinition']>[0];

/**
 * transitionStage (FR-WORK-10, CC-5, architecture 11.3): lock #4 `team`, then #8 `project_stage FOR
 * UPDATE`; the conditions are read under both locks, so an item write (lock #4 share) cannot slip
 * in between the check and the closing. The next stage and its checklist are created in the same
 * transaction. A refusal with `unmet[]` rolls everything back.
 */
@Injectable()
export class StageTransitionService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(PLAYBOOKS_API) private readonly playbooks: PlaybooksApi,
    @Inject(RouteRepository) private readonly route: RouteRepository,
    @Inject(ItemRepository) private readonly items: ItemRepository,
    @Inject(TransitionRepository) private readonly transitions: TransitionRepository,
    @Inject(ReviewService) private readonly reviews: ReviewService,
  ) {}

  transition(
    leadId: string,
    teamId: string,
    body: Body<'transitionStage'>,
  ): Promise<Ok<'transitionStage'>> {
    return this.tx.run(() => this.transitionInTx(leadId, teamId, body.fromOrdinal));
  }

  private async transitionInTx(
    leadId: string,
    teamId: string,
    from: number,
  ): Promise<Ok<'transitionStage'>> {
    const team = await this.teams.lockTeam(teamId);
    if (team.leadUserId !== leadId) throw new DomainError('NOT_TEAM_LEAD', 403);
    assertTeamWritable(team.status, true);
    const stages = await this.route.listStages(teamId);
    const found = from > MAX_ORDINAL ? undefined : stages.find((s) => s.ordinal === from);
    if (found === undefined) throw new DomainError('NOT_FOUND', 404);
    await this.locks.lockProjectStage(found.id, 'update');
    const stage = await this.items.findStage(teamId, found.id);
    if (stage === undefined) throw new DomainError('NOT_FOUND', 404);
    if (stage.status !== 'open') throw new DomainError('STAGE_NOT_OPEN', 409);

    const now = this.clock.now();
    const rows = await this.route.listItems(teamId, stage.id);
    const unmet = unmetConditions({
      items: rows,
      unpassedStepKeys: await this.reviews.unpassedStepKeys(teamId, stage.id, team.playbookId),
      openedAt: stage.openedAt,
      now,
    });
    if (unmet.length > 0) throw new DomainError('STAGE_TRANSITION_BLOCKED', 409, { unmet });

    if (!(await this.transitions.closeStage(stage.id, now, leadId))) {
      throw new DomainError('STAGE_NOT_OPEN', 409);
    }
    const events = [this.stageEvent('stage_closed', teamId, stage.id, stage.ordinal)];
    const followingOrdinal = nextOrdinal(
      stages.map((s) => s.ordinal),
      from,
    );
    const following = stages.find((s) => s.ordinal === followingOrdinal);
    if (following !== undefined) {
      await this.openNext(team.playbookId, teamId, following, now);
      events.push(this.stageEvent('stage_opened', teamId, following.id, following.ordinal));
    }
    await this.outbox.publishMany(events);
    return { closedOrdinal: from, openedOrdinal: following?.ordinal ?? null };
  }

  /** Opens the next stage and creates its checklist; executors are chosen by role as at the start (FR-WORK-02). */
  private async openNext(
    playbookId: PlaybookId,
    teamId: string,
    next: { id: string; stageKey: string; durationDays: number },
    now: Date,
  ): Promise<void> {
    if (!(await this.transitions.openStage(next.id, now, stageDueAt(now, next.durationDays)))) {
      throw new DomainError('STAGE_NOT_OPEN', 409);
    }
    const definition = await this.playbooks.getDefinition(playbookId);
    const steps = definition.stages.find((s) => s.key === next.stageKey)?.steps ?? [];
    const roster = await this.teams.getRoster(teamId);
    const members: RoleHolder[] = roster.map((m) => ({
      userId: m.userId,
      roles: m.roles.map((r) => r.roleCode),
    }));
    await this.route.insertItems(
      [...steps]
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((step) => itemRowOf(teamId, next.id, step, members, now)),
    );
  }

  private stageEvent(
    type: 'stage_closed' | 'stage_opened',
    teamId: string,
    stageId: string,
    ordinal: number,
  ): Parameters<OutboxService['publish']>[0] {
    return {
      module: WORKSPACE_MODULE,
      type,
      aggregateId: stageId,
      payload: { teamId, stageId, ordinal },
    };
  }
}
