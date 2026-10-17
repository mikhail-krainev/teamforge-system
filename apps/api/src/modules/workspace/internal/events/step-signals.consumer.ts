import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { EventConsumers } from '../../../../platform/outbox/event-consumers.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import type { EventConsumer, OutboxEventData } from '../../../../platform/outbox/outbox.types.js';
import { PLAYBOOKS_API, type PlaybooksApi } from '../../../playbooks/public.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { WORKSPACE_MODULE } from '../../public.js';
import { ArtifactRepository } from '../repositories/artifact.repository.js';
import { ItemRepository } from '../repositories/item.repository.js';
import { ARTIFACT_FILE_UPLOADED } from '../services/artifact.service.js';

/** Event of a step signal that the antifraud of `rewards` reads (architecture 8, Р-8); the score is 0. */
export const STEP_SIGNAL_RAISED = 'step_signal_raised';

const uploaded = z.object({
  teamId: z.uuid(),
  itemId: z.uuid(),
  fileId: z.uuid(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * `sha_dedup` of FR-PLAY-08 / AF-06 (docs/playbooks.md 2.4): when a file of a step that asks for the
 * check has exactly the bytes of a file that another project stored earlier, a signal `STEP_sha_dedup` (score 0) goes
 * out as an event. Nothing blocks: the file is accepted, the signal is for the administrator and for
 * the completion check of `rewards`. The event carries the hash count, never bytes or names.
 */
@Injectable()
export class StepSignalsConsumer implements EventConsumer, OnModuleInit {
  readonly consumer = 'workspace.step-signals';
  readonly types = [`${WORKSPACE_MODULE}.${ARTIFACT_FILE_UPLOADED}`];

  constructor(
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(PLAYBOOKS_API) private readonly playbooks: PlaybooksApi,
    @Inject(ItemRepository) private readonly items: ItemRepository,
    @Inject(ArtifactRepository) private readonly files: ArtifactRepository,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this);
  }

  /** Runs inside the inbox transaction: the signal event commits with the inbox row, once. */
  async handle(event: OutboxEventData): Promise<void> {
    const parsed = uploaded.safeParse(event.payload);
    if (!parsed.success) return;
    const { teamId, itemId, fileId, sha256 } = parsed.data;
    const stepKey = await this.stepAsking(teamId, itemId, 'sha_dedup');
    if (stepKey === undefined) return;
    const otherTeams = await this.files.countEarlierInOtherTeams(
      teamId,
      fileId,
      Buffer.from(sha256, 'hex'),
    );
    if (otherTeams === 0) return;
    await this.outbox.publish({
      module: WORKSPACE_MODULE,
      type: STEP_SIGNAL_RAISED,
      aggregateId: fileId,
      payload: {
        teamId,
        itemId,
        fileId,
        stepKey,
        ruleCode: 'STEP_sha_dedup',
        phase: 'step_check',
        score: 0,
        otherTeams,
      },
    });
  }

  /** The step key of the item when its step lists the check, otherwise `undefined`. */
  private async stepAsking(
    teamId: string,
    itemId: string,
    check: string,
  ): Promise<string | undefined> {
    const item = await this.items.findItem(teamId, itemId);
    const team = await this.teams.getTeamView(teamId);
    if (item === undefined || team === null) return undefined;
    const stage = await this.items.findStage(teamId, item.projectStageId);
    const definition = await this.playbooks.getDefinition(team.playbookId);
    const step = definition.stages
      .find((s) => s.key === stage?.stageKey)
      ?.steps.find((s) => s.key === item.stepKey);
    return step?.autoChecks.some((key) => key.split(':')[0] === check) ? item.stepKey : undefined;
  }
}
