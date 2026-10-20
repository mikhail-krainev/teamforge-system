import { Inject, Injectable } from '@nestjs/common';
import type { Body } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { TEAMS_API, type RosterMember, type TeamsApi } from '../../../teams/public.js';
import { WORKSPACE_MODULE } from '../../public.js';
import { fallbackAfterDeparture } from '../domain/item-rules.js';
import { chooseExecutor, type RoleHolder } from '../domain/route-plan.js';
import { ItemRepository } from '../repositories/item.repository.js';
import { ItemGate, VersionConflict } from './item-gate.js';
import type { ChecklistItemDto } from './route-dto.js';
import { RouteQueryService } from './route-query.service.js';

const holdersOf = (roster: readonly RosterMember[]): RoleHolder[] =>
  roster.map((m) => ({ userId: m.userId, roles: m.roles.map((r) => r.roleCode) }));

/**
 * Fallback steps (FR-WORK-02, FR-TEAM-11, architecture 11). A step whose role nobody holds goes to
 * its fallback when the project starts or when the last holder leaves; it is never lifted by
 * itself when the role appears later: the lead returns the regular step with `revertFallback`.
 */
@Injectable()
export class FallbackService {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(ItemGate) private readonly gate: ItemGate,
    @Inject(ItemRepository) private readonly items: ItemRepository,
    @Inject(RouteQueryService) private readonly query: RouteQueryService,
  ) {}

  async revert(
    leadId: string,
    teamId: string,
    itemId: string,
    body: Body<'revertFallback'>,
  ): Promise<ChecklistItemDto> {
    try {
      await this.tx.run(() => this.revertInTx(leadId, teamId, itemId, body.version));
    } catch (error) {
      if (error instanceof VersionConflict) throw await this.gate.conflict(teamId, itemId);
      throw error;
    }
    return this.query.getItem(teamId, itemId);
  }

  private async revertInTx(
    leadId: string,
    teamId: string,
    itemId: string,
    version: number,
  ): Promise<void> {
    const { item } = await this.gate.open(teamId, itemId, { lead: leadId });
    if (item.version !== version) throw new VersionConflict();
    if (!item.fallbackUsed) throw new DomainError('INVALID_STATE', 409);
    const executor = chooseExecutor(item, holdersOf(await this.teams.getRoster(teamId)));
    // Nobody holds the role yet: the fallback is still the only way to do the step.
    if (executor.fallbackUsed) throw new DomainError('INVALID_STATE', 409);
    const named = executor.assigneeUserId !== null;
    const row = await this.items.updateIfVersion(
      itemId,
      version,
      {
        fallbackUsed: false,
        ...(named
          ? {
              assigneeUserId: executor.assigneeUserId,
              roleCode: executor.roleCode,
              unassignedFromUserId: null,
            }
          : {}),
      },
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

  /**
   * `teams.member_left` / `teams.member_excluded` (FR-TEAM-11): the open items the member carried
   * stay without an executor (and remember whose they were, for the lead's list), and the steps of
   * a role nobody holds any more switch to the fallback. Re-reads the roster, so a repeated
   * delivery changes nothing. Runs inside the inbox transaction.
   */
  async afterDeparture(teamId: string, userId: string): Promise<void> {
    const holders = holdersOf(await this.teams.getRoster(teamId));
    const now = this.clock.now();
    for (const item of await this.items.openItemsOfOpenStage(teamId)) {
      const carried = item.assigneeUserId === userId;
      const fallbackUsed = fallbackAfterDeparture(item, item.fallbackUsed, holders);
      if (!carried && fallbackUsed === item.fallbackUsed) continue;
      await this.items.update(
        item.id,
        {
          fallbackUsed,
          ...(carried
            ? { assigneeUserId: null, roleCode: null, unassignedFromUserId: userId }
            : {}),
        },
        now,
      );
      await this.outbox.publish({
        module: WORKSPACE_MODULE,
        type: 'item_updated',
        aggregateId: item.id,
        payload: { teamId, itemId: item.id, version: item.version + 1 },
      });
    }
  }
}
