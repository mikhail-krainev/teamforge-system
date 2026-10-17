import { Inject, Injectable } from '@nestjs/common';
import type { Body } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { WORKSPACE_MODULE } from '../../public.js';
import { executorRole } from '../domain/item-rules.js';
import { ItemRepository } from '../repositories/item.repository.js';
import { ItemGate, VersionConflict } from './item-gate.js';
import type { ChecklistItemDto } from './route-dto.js';
import { RouteQueryService } from './route-query.service.js';

/**
 * assignChecklistItem (FR-WORK-02, -03, FR-TEAM-13): the lead names the executor of an item, from
 * the active members of the team. This is how the items of a departed member and the steps that
 * went to the fallback find a person. `fallback_used` is not touched: only revertFallback lifts it.
 */
@Injectable()
export class ItemAssignService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(ItemGate) private readonly gate: ItemGate,
    @Inject(ItemRepository) private readonly items: ItemRepository,
    @Inject(RouteQueryService) private readonly query: RouteQueryService,
  ) {}

  async assign(
    leadId: string,
    teamId: string,
    itemId: string,
    body: Body<'assignChecklistItem'>,
  ): Promise<ChecklistItemDto> {
    try {
      await this.tx.run(() => this.assignInTx(leadId, teamId, itemId, body));
    } catch (error) {
      if (error instanceof VersionConflict) throw await this.gate.conflict(teamId, itemId);
      throw error;
    }
    return this.query.getItem(teamId, itemId);
  }

  private async assignInTx(
    leadId: string,
    teamId: string,
    itemId: string,
    body: Body<'assignChecklistItem'>,
  ): Promise<void> {
    const { item } = await this.gate.open(teamId, itemId, { lead: leadId });
    if (item.version !== body.version) throw new VersionConflict();
    const roster = await this.teams.getRoster(teamId);
    const executor = roster.find((m) => m.userId === body.userId);
    if (executor === undefined) {
      throw new DomainError('VALIDATION_FAILED', 422, {
        errors: [{ pointer: '/userId', message: 'The executor is an active member of the team' }],
      });
    }
    const role = executorRole(
      item,
      executor.roles.map((r) => r.roleCode),
    );
    const row = await this.items.updateIfVersion(
      itemId,
      body.version,
      { assigneeUserId: executor.userId, roleCode: role, unassignedFromUserId: null },
      this.clock.now(),
    );
    if (row === undefined) throw new VersionConflict();
    await this.outbox.publish({
      module: WORKSPACE_MODULE,
      type: 'item_updated',
      aggregateId: itemId,
      payload: { teamId, itemId, version: row.version },
    });
  }
}
