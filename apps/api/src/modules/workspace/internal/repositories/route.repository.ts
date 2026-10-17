import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { artifactFile } from '../schema/artifact.js';
import { reviewAnswer, reviewRisk } from '../schema/artifact.js';
import { checklistItem, projectStage } from '../schema/stage.js';

export type StageRow = typeof projectStage.$inferSelect;
export type ItemRow = typeof checklistItem.$inferSelect;
export type FileRow = typeof artifactFile.$inferSelect;
export type ReviewAnswerRow = typeof reviewAnswer.$inferSelect;
export type ReviewRiskRow = typeof reviewRisk.$inferSelect;

/**
 * Stages and checklist items of a project (architecture 5.7). Every read takes the team id: the
 * chain team -> stage -> item is filtered in the query itself (architecture 13.14, point 2).
 */
@Injectable()
export class RouteRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** Idempotent: a repeated start finds the rows (`UNIQUE (team_id, ordinal)`) and changes nothing. */
  async insertStages(rows: (typeof projectStage.$inferInsert)[]): Promise<void> {
    if (rows.length === 0) return;
    await this.tx.tx
      .insert(projectStage)
      .values(rows)
      .onConflictDoNothing({ target: [projectStage.teamId, projectStage.ordinal] });
  }

  /** Idempotent through `UNIQUE (project_stage_id, step_key)`. */
  async insertItems(rows: (typeof checklistItem.$inferInsert)[]): Promise<void> {
    if (rows.length === 0) return;
    await this.tx.tx
      .insert(checklistItem)
      .values(rows)
      .onConflictDoNothing({ target: [checklistItem.projectStageId, checklistItem.stepKey] });
  }

  listStages(teamId: string): Promise<StageRow[]> {
    return this.tx.tx
      .select()
      .from(projectStage)
      .where(eq(projectStage.teamId, teamId))
      .orderBy(asc(projectStage.ordinal));
  }

  async findStage(teamId: string, ordinal: number): Promise<StageRow | undefined> {
    const rows = await this.tx.tx
      .select()
      .from(projectStage)
      .where(and(eq(projectStage.teamId, teamId), eq(projectStage.ordinal, ordinal)));
    return rows[0];
  }

  listItems(teamId: string, stageId: string): Promise<ItemRow[]> {
    return this.tx.tx
      .select()
      .from(checklistItem)
      .where(and(eq(checklistItem.teamId, teamId), eq(checklistItem.projectStageId, stageId)))
      .orderBy(asc(checklistItem.stepKey));
  }

  listFiles(teamId: string, itemIds: string[]): Promise<FileRow[]> {
    if (itemIds.length === 0) return Promise.resolve([]);
    return this.tx.tx
      .select()
      .from(artifactFile)
      .where(
        and(
          eq(artifactFile.teamId, teamId),
          inArray(artifactFile.checklistItemId, itemIds),
          isNull(artifactFile.deletedAt),
        ),
      )
      .orderBy(asc(artifactFile.createdAt), asc(artifactFile.id));
  }

  listReviewAnswers(itemIds: string[]): Promise<ReviewAnswerRow[]> {
    if (itemIds.length === 0) return Promise.resolve([]);
    return this.tx.tx
      .select()
      .from(reviewAnswer)
      .where(inArray(reviewAnswer.checklistItemId, itemIds));
  }

  listReviewRisks(itemIds: string[]): Promise<ReviewRiskRow[]> {
    if (itemIds.length === 0) return Promise.resolve([]);
    return this.tx.tx.select().from(reviewRisk).where(inArray(reviewRisk.checklistItemId, itemIds));
  }
}
