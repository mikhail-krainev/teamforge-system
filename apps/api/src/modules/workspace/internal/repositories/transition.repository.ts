import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { participationConfirm } from '../schema/release.js';
import { projectStage } from '../schema/stage.js';
import type { StageRow } from './route.repository.js';

export type ParticipationRow = typeof participationConfirm.$inferSelect;

/** Writes of the stage transition and of the participation confirmations (architecture 11.3, FR-WORK-11). */
@Injectable()
export class TransitionRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** Called under lock #8; the status condition is the second line of defence of `project_stage_one_open_uq`. */
  async closeStage(stageId: string, now: Date, leadId: string): Promise<boolean> {
    const rows = await this.tx.tx
      .update(projectStage)
      .set({
        status: 'closed',
        closedAt: now,
        closedBy: leadId,
        version: sql`${projectStage.version} + 1`,
      })
      .where(and(eq(projectStage.id, stageId), eq(projectStage.status, 'open')))
      .returning({ id: projectStage.id });
    return rows.length === 1;
  }

  async openStage(stageId: string, openedAt: Date, dueAt: Date): Promise<boolean> {
    const rows = await this.tx.tx
      .update(projectStage)
      .set({
        status: 'open',
        openedAt,
        dueAt,
        version: sql`${projectStage.version} + 1`,
      })
      .where(and(eq(projectStage.id, stageId), eq(projectStage.status, 'pending')))
      .returning({ id: projectStage.id });
    return rows.length === 1;
  }

  /** Idempotent: the first confirmation stays (who and when), a repeat changes nothing. */
  async confirm(row: typeof participationConfirm.$inferInsert): Promise<ParticipationRow> {
    await this.tx.tx.insert(participationConfirm).values(row).onConflictDoNothing();
    const rows = await this.tx.tx
      .select()
      .from(participationConfirm)
      .where(
        and(
          eq(participationConfirm.teamId, row.teamId),
          eq(participationConfirm.userId, row.userId),
          eq(participationConfirm.stageOrdinal, row.stageOrdinal),
        ),
      );
    const found = rows[0];
    if (found === undefined) throw new Error('participation_confirm row vanished');
    return found;
  }

  /** Open stages that are due before `until`, by `project_stage_due_idx` (no locks). */
  dueBefore(until: Date, limit: number): Promise<StageRow[]> {
    return this.tx.tx
      .select()
      .from(projectStage)
      .where(and(eq(projectStage.status, 'open'), lte(projectStage.dueAt, until)))
      .orderBy(asc(projectStage.dueAt))
      .limit(limit);
  }
}
