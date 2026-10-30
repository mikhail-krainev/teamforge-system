import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { adminAudit, dispute, fraudCase, fraudSignal } from '../schema/rewards.js';

export type FraudCaseRow = typeof fraudCase.$inferSelect;
export type FraudSignalRow = typeof fraudSignal.$inferSelect;
export type DisputeRow = typeof dispute.$inferSelect;

export interface NewSignal {
  phase: 'completion' | 'cooling_end';
  ruleCode: string;
  action: 'block' | 'flag' | 'signal' | 'info';
  score: number;
  data: Record<string, unknown>;
}

export interface CaseKey {
  openedAt: Date;
  id: string;
}

/** `fraud_signal`, `fraud_case`, `dispute`, `admin_audit` (FR-REW-15, FR-REW-16, AF-25). */
@Injectable()
export class FraudRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** One row per rule and phase (`fraud_signal_uq`); a second run of the phase adds nothing. */
  async insertSignals(teamId: string, signals: NewSignal[], at: Date): Promise<void> {
    if (signals.length === 0) return;
    await this.tx.tx
      .insert(fraudSignal)
      .values(signals.map((s) => ({ id: uuidv7(), teamId, createdAt: at, ...s })))
      .onConflictDoNothing();
  }

  /** Opens the case of the team; `fraud_case_open_uq` keeps it to one open case, `false` when one is open already. */
  async openCase(teamId: string, at: Date): Promise<string | undefined> {
    const rows = await this.tx.tx
      .insert(fraudCase)
      .values({ id: uuidv7(), teamId, status: 'open', openedAt: at })
      .onConflictDoNothing()
      .returning({ id: fraudCase.id });
    return rows[0]?.id;
  }

  async findCase(caseId: string): Promise<FraudCaseRow | undefined> {
    const [row] = await this.tx.tx.select().from(fraudCase).where(eq(fraudCase.id, caseId));
    return row;
  }

  /**
   * S7SEC-01: the rule codes the last decision `ok` of the team saw (its signals were stored before the decision), or
   * `undefined` when no case of the team was closed with `ok`.
   */
  async reviewedRuleCodes(teamId: string): Promise<Set<string> | undefined> {
    const [decided] = await this.tx.tx
      .select({ at: fraudCase.decidedAt })
      .from(fraudCase)
      .where(and(eq(fraudCase.teamId, teamId), eq(fraudCase.status, 'ok')))
      .orderBy(desc(fraudCase.decidedAt))
      .limit(1);
    if (decided?.at == null) return undefined;
    const rows = await this.tx.tx
      .selectDistinct({ ruleCode: fraudSignal.ruleCode })
      .from(fraudSignal)
      .where(
        and(
          eq(fraudSignal.teamId, teamId),
          sql`${fraudSignal.createdAt} <= ${decided.at.toISOString()}::timestamptz`,
        ),
      );
    return new Set(rows.map((r) => r.ruleCode));
  }

  async openCaseOfTeam(teamId: string): Promise<FraudCaseRow | undefined> {
    const [row] = await this.tx.tx
      .select()
      .from(fraudCase)
      .where(and(eq(fraudCase.teamId, teamId), eq(fraudCase.status, 'open')));
    return row;
  }

  /** The case row under `FOR UPDATE`: taken after lock #11 of its run, so two decisions queue behind the run. */
  async lockCase(caseId: string): Promise<FraudCaseRow | undefined> {
    const [row] = await this.tx.tx
      .select()
      .from(fraudCase)
      .where(eq(fraudCase.id, caseId))
      .for('update');
    return row;
  }

  async decide(
    caseId: string,
    status: 'ok' | 'violation',
    by: string,
    comment: string,
    at: Date,
  ): Promise<void> {
    await this.tx.tx
      .update(fraudCase)
      .set({ status, decidedBy: by, decidedAt: at, comment })
      .where(and(eq(fraudCase.id, caseId), eq(fraudCase.status, 'open')));
  }

  /** The page of the queue, oldest first inside a status (`fraud_case_status_idx`), keyset by (opened_at, id). */
  listCases(
    status: string | undefined,
    after: CaseKey | undefined,
    limit: number,
  ): Promise<FraudCaseRow[]> {
    const keyset =
      after === undefined
        ? undefined
        : or(
            sql`${fraudCase.openedAt} > ${after.openedAt.toISOString()}::timestamptz`,
            and(
              sql`${fraudCase.openedAt} = ${after.openedAt.toISOString()}::timestamptz`,
              sql`${fraudCase.id} > ${after.id}::uuid`,
            ),
          );
    return this.tx.tx
      .select()
      .from(fraudCase)
      .where(and(status === undefined ? undefined : eq(fraudCase.status, status), keyset))
      .orderBy(asc(fraudCase.openedAt), asc(fraudCase.id))
      .limit(limit);
  }

  signalsOf(teamIds: string[]): Promise<FraudSignalRow[]> {
    if (teamIds.length === 0) return Promise.resolve([]);
    return this.tx.tx
      .select()
      .from(fraudSignal)
      .where(inArray(fraudSignal.teamId, teamIds))
      .orderBy(asc(fraudSignal.teamId), asc(fraudSignal.phase), asc(fraudSignal.ruleCode));
  }

  disputesOf(teamIds: string[]): Promise<DisputeRow[]> {
    if (teamIds.length === 0) return Promise.resolve([]);
    return this.tx.tx
      .select()
      .from(dispute)
      .where(inArray(dispute.teamId, teamIds))
      .orderBy(asc(dispute.createdAt), asc(dispute.id));
  }

  /** `dispute_team_user_uq`: a person disputes a project once; `undefined` when he did already. */
  async insertDispute(
    teamId: string,
    userId: string,
    text: string,
    at: Date,
  ): Promise<DisputeRow | undefined> {
    const rows = await this.tx.tx
      .insert(dispute)
      .values({ id: uuidv7(), teamId, userId, text, createdAt: at })
      .onConflictDoNothing()
      .returning();
    return rows[0];
  }

  async insertAudit(row: {
    actorUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    reason: string;
    data: Record<string, unknown>;
    at: Date;
  }): Promise<void> {
    await this.tx.tx.insert(adminAudit).values({ id: uuidv7(), ...row });
  }
}
