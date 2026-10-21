import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { Clock } from '../../../../platform/clock/clock.js';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { PLAYBOOKS_API, type PlaybooksApi } from '../../../playbooks/public.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { WORKSPACE_MODULE } from '../../public.js';
import { contributionRole } from '../domain/contribution-role.js';
import { CONTRIBUTION_RECORDED } from '../events/contribution.consumer.js';
import { ContributionRepository } from '../repositories/contribution.repository.js';
import { ItemRepository } from '../repositories/item.repository.js';
import type { ItemRow } from '../repositories/route.repository.js';

const itemUpdated = z.object({ teamId: z.uuid(), itemId: z.uuid() });

/** `any` is not a role: a step open to everybody says nothing about the label. */
const ANY_ROLE = 'any';

/**
 * Contributions of artifacts and rituals (FR-WORK-16, FR-WORK-17, architecture 7.6): a checklist item
 * that is `done` is a contribution of its executor (`source` artifact/ritual, `ref` `item:<itemId>`); an
 * item that went back to `open` stops counting. The item is read again (under `FOR SHARE`, so a later
 * write of the item waits for this transaction), not taken from the event: events of one item are not
 * delivered in order, the stored state is the truth and the handler is idempotent.
 */
@Injectable()
export class ItemContributionConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'workspace.item-contributions';
  readonly types = [`${WORKSPACE_MODULE}.item_updated`];

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(ItemRepository) private readonly items: ItemRepository,
    @Inject(ContributionRepository) private readonly contributions: ContributionRepository,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(PLAYBOOKS_API) private readonly playbooks: PlaybooksApi,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  async handle(event: OutboxEventData): Promise<void> {
    const parsed = itemUpdated.safeParse(event.payload);
    if (!parsed.success) return;
    const { teamId, itemId } = parsed.data;
    const item = await this.items.findItemShared(teamId, itemId);
    if (item === undefined) return;
    const source = item.kind === 'ritual' ? 'ritual' : 'artifact';
    const ref = `item:${item.id}`;
    const changed =
      item.status === 'done'
        ? await this.credit(item, source, ref)
        : await this.contributions.deactivate(teamId, source, ref);
    await this.announce(teamId, changed);
  }

  private async credit(
    item: ItemRow,
    source: 'artifact' | 'ritual',
    ref: string,
  ): Promise<string[]> {
    const userId = item.assigneeUserId ?? item.doneBy;
    const doneAt = item.doneAt;
    if (userId === null || doneAt === null) return [];
    const roster = await this.teams.getRoster(item.teamId);
    const held = roster.find((member) => member.userId === userId)?.roles ?? [];
    // The member's own choice first, then the role of the step, then the role he holds longest.
    const wanted = [item.roleCode, item.ownerRole, ...item.altRoles].filter(
      (code): code is string => code !== null && code !== ANY_ROLE,
    );
    const roleCode = contributionRole(
      wanted.map((code) => `role:${code}`),
      held,
    );
    if (roleCode === undefined) return [];
    const [stage, title] = await Promise.all([
      this.items.findStage(item.teamId, item.projectStageId),
      this.stepTitle(item),
    ]);
    return this.contributions.record([
      {
        teamId: item.teamId,
        userId,
        source,
        ref,
        title,
        url: null,
        roleCode,
        stageOrdinal: stage?.ordinal ?? null,
        occurredAt: doneAt,
        receivedAt: doneAt,
      },
    ]);
  }

  private async stepTitle(item: ItemRow): Promise<string> {
    const team = await this.teams.getTeamView(item.teamId);
    if (team === null) return item.stepKey;
    const stage = await this.items.findStage(item.teamId, item.projectStageId);
    const definition = await this.playbooks.getDefinition(team.playbookId);
    const step = definition.stages
      .find((s) => s.key === stage?.stageKey)
      ?.steps.find((s) => s.key === item.stepKey);
    return step?.title ?? item.stepKey;
  }

  private async announce(teamId: string, contributionIds: string[]): Promise<void> {
    if (contributionIds.length === 0) return;
    await this.outbox.publishMany(
      contributionIds.map((contributionId) => ({
        module: WORKSPACE_MODULE,
        type: CONTRIBUTION_RECORDED,
        aggregateId: teamId,
        payload: { teamId, contributionId, at: this.clock.now().toISOString() },
      })),
    );
  }
}
