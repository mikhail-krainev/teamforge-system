import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import {
  PLAYBOOKS_API,
  type PlaybooksApi,
  type StepDefinition,
} from '../../../playbooks/public.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { ItemRepository } from '../repositories/item.repository.js';
import { RouteRepository, type ItemRow, type StageRow } from '../repositories/route.repository.js';
import { toItemDto, toStageDto, type ChecklistItemDto, type ProjectStageDto } from './route-dto.js';

/** `project_stage.ordinal` is a smallint: a larger number cannot exist. */
const MAX_ORDINAL = 32_767;

/** `listStages` and `getStageChecklist` (FR-WORK-01, -02, -12). Membership is checked by the guard. */
@Injectable()
export class RouteQueryService {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(PLAYBOOKS_API) private readonly playbooks: PlaybooksApi,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(RouteRepository) private readonly route: RouteRepository,
    @Inject(ItemRepository) private readonly items: ItemRepository,
  ) {}

  /** A team that has not started has no stages and no planned end. */
  async listStages(
    teamId: string,
  ): Promise<{ items: ProjectStageDto[]; plannedEndAt: string | null }> {
    const [team, rows] = await Promise.all([
      this.teams.getTeamView(teamId),
      this.route.listStages(teamId),
    ]);
    if (team === null) throw new DomainError('NOT_FOUND', 404);
    const now = this.clock.now();
    const context = {
      now,
      team,
      plannedEndAt: team.plannedEndAt,
    };
    return {
      items: rows.map((row) => toStageDto(row, context)),
      plannedEndAt: team.plannedEndAt?.toISOString() ?? null,
    };
  }

  async getStageChecklist(teamId: string, ordinal: number): Promise<{ items: ChecklistItemDto[] }> {
    const stage = ordinal > MAX_ORDINAL ? undefined : await this.route.findStage(teamId, ordinal);
    if (stage === undefined) throw new DomainError('NOT_FOUND', 404);
    const rows = await this.route.listItems(teamId, stage.id);
    return { items: await this.dtosOf(teamId, stage, rows) };
  }

  /** One item as the client sees it; 404 for an item of another team (architecture 13.14). */
  async getItem(teamId: string, itemId: string): Promise<ChecklistItemDto> {
    const row = await this.items.findItem(teamId, itemId);
    const stage =
      row === undefined ? undefined : await this.items.findStage(teamId, row.projectStageId);
    if (row === undefined || stage === undefined) throw new DomainError('NOT_FOUND', 404);
    const [dto] = await this.dtosOf(teamId, stage, [row]);
    if (dto === undefined) throw new DomainError('NOT_FOUND', 404);
    return dto;
  }

  private async dtosOf(
    teamId: string,
    stage: StageRow,
    rows: ItemRow[],
  ): Promise<ChecklistItemDto[]> {
    const team = await this.teams.getTeamView(teamId);
    if (team === null) throw new DomainError('NOT_FOUND', 404);
    const definition = await this.playbooks.getDefinition(team.playbookId);
    const steps = new Map<string, StepDefinition>(
      (definition.stages.find((s) => s.key === stage.stageKey)?.steps ?? []).map((s) => [s.key, s]),
    );
    const ids = rows.map((r) => r.id);
    const [files, answers, risks] = await Promise.all([
      this.route.listFiles(teamId, ids),
      this.route.listReviewAnswers(ids),
      this.route.listReviewRisks(ids),
    ]);
    return rows
      .map((row) => ({ row, step: steps.get(row.stepKey) }))
      .sort((a, b) => (a.step?.ordinal ?? 0) - (b.step?.ordinal ?? 0))
      .map(({ row, step }) =>
        toItemDto(row, {
          stageOrdinal: stage.ordinal,
          step,
          files: files.filter((f) => f.checklistItemId === row.id),
          review: {
            answers: answers.filter((a) => a.checklistItemId === row.id),
            risks: risks.filter((r) => r.checklistItemId === row.id),
          },
        }),
      );
  }
}
