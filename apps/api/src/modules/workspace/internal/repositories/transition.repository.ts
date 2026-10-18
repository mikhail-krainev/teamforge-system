import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
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

  /** `suspendedAppliedSeconds` is the team's finished suspension time at the opening: it is not counted for this stage. */
  async openStage(
    stageId: string,
    openedAt: Date,
    dueAt: Date,
    suspendedAppliedSeconds: number,
  ): Promise<boolean> {
    const rows = await this.tx.tx
      .update(projectStage)
      .set({
        status: 'open',
        openedAt,
        dueAt,
        suspendedAppliedSeconds,
        version: sql`${projectStage.version} + 1`,
      })
      .where(and(eq(projectStage.id, stageId), eq(projectStage.status, 'pending')))
      .returning({ id: projectStage.id });
    return rows.length === 1;
  }

  /**
   * FR-WORK-18: the open stage gets the finished suspension time it has not got yet, once. One
   * conditional UPDATE: a repeat, a parallel run or an older total changes nothing (the applied
   * counter only grows). Returns the number of stages moved.
   */
  async applySuspension(teamId: string, totalSeconds: number): Promise<number> {
    const rows = await this.tx.tx
      .update(projectStage)
      .set({
        dueAt: sql`${projectStage.dueAt} + (${totalSeconds} - ${projectStage.suspendedAppliedSeconds}) * interval '1 second'`,
        suspendedAppliedSeconds: totalSeconds,
        version: sql`${projectStage.version} + 1`,
      })
      .where(
        and(
          eq(projectStage.teamId, teamId),
          eq(projectStage.status, 'open'),
          isNotNull(projectStage.dueAt),
          lt(projectStage.suspendedAppliedSeconds, totalSeconds),
        ),
      )
      .returning({ id: projectStage.id });
    return rows.length;
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

  /**
   * Open stages that are due before `until`, by `project_stage_due_idx` (no locks). Keyset paging
   * after `(dueAt, id)`: the caller walks all pages, so stages that were handled already (or that
   * are skipped, like those of a suspended team) never hide the later ones.
   */
  dueBefore(until: Date, limit: number, after?: { dueAt: Date; id: string }): Promise<StageRow[]> {
    return this.tx.tx
      .select()
      .from(projectStage)
      .where(
        and(
          eq(projectStage.status, 'open'),
          lte(projectStage.dueAt, until),
          after === undefined
            ? undefined
            : or(
                gt(projectStage.dueAt, after.dueAt),
                and(eq(projectStage.dueAt, after.dueAt), gt(projectStage.id, after.id)),
              ),
        ),
      )
      .orderBy(asc(projectStage.dueAt), asc(projectStage.id))
      .limit(limit);
  }
}
