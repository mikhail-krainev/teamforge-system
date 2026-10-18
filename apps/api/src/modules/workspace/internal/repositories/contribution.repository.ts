import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { contribution } from '../schema/contribution.js';
import { projectStage } from '../schema/stage.js';

export interface NewContribution {
  teamId: string;
  userId: string;
  source: 'issue' | 'pr' | 'artifact' | 'ritual';
  ref: string;
  title: string;
  url: string | null;
  roleCode: string;
  stageOrdinal: number | null;
  occurredAt: Date;
  receivedAt: Date;
}

/** `workspace.contribution` (architecture 5.7). Every source ends on `contribution_uq`, so a repeat is a no-op (CC-11). */
@Injectable()
export class ContributionRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** The stage the contribution belongs to: the one open at the time, or the last one opened before it. */
  async stageOrdinalAt(teamId: string, at: Date): Promise<number | null> {
    const [row] = await this.tx.tx
      .select({ ordinal: projectStage.ordinal })
      .from(projectStage)
      .where(and(eq(projectStage.teamId, teamId), lte(projectStage.openedAt, at)))
      .orderBy(desc(projectStage.ordinal))
      .limit(1);
    return row?.ordinal ?? null;
  }

  /**
   * `INSERT ... ON CONFLICT (team_id, source, ref, user_id) DO UPDATE SET active = true WHERE NOT active`
   * (architecture 7.6): a new row, or a row that a reopened issue had switched off. Returns the ids that
   * changed; a row that already counts is left exactly as it is (its role may have been relabelled).
   */
  async record(rows: NewContribution[]): Promise<string[]> {
    if (rows.length === 0) return [];
    const changed = await this.tx.tx
      .insert(contribution)
      .values(rows.map((row) => ({ id: uuidv7(), ...row })))
      .onConflictDoUpdate({
        target: [contribution.teamId, contribution.source, contribution.ref, contribution.userId],
        set: { active: true },
        setWhere: sql`${contribution.active} = false`,
      })
      .returning({ id: contribution.id });
    return changed.map((row) => row.id);
  }

  /** The contribution of this member in this team; one of somebody else or of another team looks like a missing one. */
  async findOwn(
    teamId: string,
    contributionId: string,
    userId: string,
  ): Promise<typeof contribution.$inferSelect | undefined> {
    const [row] = await this.tx.tx
      .select()
      .from(contribution)
      .where(
        and(
          eq(contribution.id, contributionId),
          eq(contribution.teamId, teamId),
          eq(contribution.userId, userId),
        ),
      );
    return row;
  }

  /** The new label; a locked label (the project is completed, FR-WORK-17) never changes. */
  async setRole(
    contributionId: string,
    roleCode: string,
  ): Promise<typeof contribution.$inferSelect | undefined> {
    const [row] = await this.tx.tx
      .update(contribution)
      .set({ roleCode })
      .where(and(eq(contribution.id, contributionId), eq(contribution.roleLocked, false)))
      .returning();
    return row;
  }

  /** The issue was reopened: its contributions stop counting. Returns the ids that changed. */
  async deactivate(
    teamId: string,
    source: NewContribution['source'],
    ref: string,
  ): Promise<string[]> {
    const changed = await this.tx.tx
      .update(contribution)
      .set({ active: false })
      .where(
        and(
          eq(contribution.teamId, teamId),
          eq(contribution.source, source),
          eq(contribution.ref, ref),
          eq(contribution.active, true),
        ),
      )
      .returning({ id: contribution.id });
    return changed.map((row) => row.id);
  }
}
