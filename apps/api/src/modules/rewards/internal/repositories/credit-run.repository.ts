import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import type { RunStatus } from '../domain/constants.js';
import { creditRun } from '../schema/rewards.js';

/** The position of a due run in the order of `dueTeamIds` (keyset paging). */
export interface DueCursor {
  teamId: string;
  coolingUntil: Date;
}

export type CreditRunRow = typeof creditRun.$inferSelect;

export interface NewCreditRun {
  teamId: string;
  completedAt: Date;
  coolingUntil: Date;
  status: RunStatus;
  rosterHash: Buffer;
  fraudScore: number;
}

/** `rewards.credit_run`: one row per completed project and the lock #11 (CC-6, CC-12). */
@Injectable()
export class CreditRunRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** `ON CONFLICT DO NOTHING`: true only for the transaction that created the row (the event and the scanner race). */
  async insert(row: NewCreditRun): Promise<boolean> {
    const rows = await this.tx.tx
      .insert(creditRun)
      .values(row)
      .onConflictDoNothing()
      .returning({ teamId: creditRun.teamId });
    return rows.length === 1;
  }

  async find(teamId: string): Promise<CreditRunRow | undefined> {
    const [row] = await this.tx.tx.select().from(creditRun).where(eq(creditRun.teamId, teamId));
    return row;
  }

  async setState(
    teamId: string,
    patch: Partial<Pick<CreditRunRow, 'status' | 'fraudScore' | 'creditedAt'>>,
  ): Promise<void> {
    await this.tx.tx
      .update(creditRun)
      .set({ ...patch, version: sql`${creditRun.version} + 1` })
      .where(eq(creditRun.teamId, teamId));
  }

  /** Runs in the cooling whose time is over, oldest first (`credit_run_cooling_idx`). */
  async dueTeamIds(now: Date, limit: number, after?: DueCursor): Promise<DueCursor[]> {
    const rows = await this.tx.tx
      .select({ teamId: creditRun.teamId, coolingUntil: creditRun.coolingUntil })
      .from(creditRun)
      .where(
        and(
          eq(creditRun.status, 'cooling'),
          lte(creditRun.coolingUntil, now),
          after === undefined
            ? undefined
            : sql`(${creditRun.coolingUntil}, ${creditRun.teamId}) > (${after.coolingUntil.toISOString()}::timestamptz, ${after.teamId}::uuid)`,
        ),
      )
      .orderBy(asc(creditRun.coolingUntil), asc(creditRun.teamId))
      .limit(limit);
    return rows;
  }

  /** Of these teams, the ones that have a run. */
  async existing(teamIds: string[]): Promise<Set<string>> {
    if (teamIds.length === 0) return new Set();
    const rows = await this.tx.tx
      .select({ teamId: creditRun.teamId })
      .from(creditRun)
      .where(inArray(creditRun.teamId, teamIds));
    return new Set(rows.map((r) => r.teamId));
  }

  /** AF-13, AF-08: the other projects of the same team composition that are not revoked. */
  async sameRosterTeamIds(rosterHash: Buffer, exceptTeamId: string): Promise<string[]> {
    const rows = await this.tx.tx
      .select({ teamId: creditRun.teamId })
      .from(creditRun)
      .where(
        and(
          eq(creditRun.rosterHash, rosterHash),
          ne(creditRun.teamId, exceptTeamId),
          ne(creditRun.status, 'revoked'),
        ),
      );
    return rows.map((r) => r.teamId);
  }

  /** AF-02: of these teams, the ones whose project is not revoked. */
  async nonRevoked(teamIds: string[]): Promise<Set<string>> {
    if (teamIds.length === 0) return new Set();
    const rows = await this.tx.tx
      .select({ teamId: creditRun.teamId })
      .from(creditRun)
      .where(and(inArray(creditRun.teamId, teamIds), ne(creditRun.status, 'revoked')));
    return new Set(rows.map((r) => r.teamId));
  }
}
