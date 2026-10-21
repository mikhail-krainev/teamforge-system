import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import type { UserStats } from '../domain/award-rules.js';
import { credit, projectCredit } from '../schema/rewards.js';

export type ProjectCreditInsert = typeof projectCredit.$inferInsert;
export type CreditInsert = typeof credit.$inferInsert;
export type CreditRow = typeof credit.$inferSelect;
export type ProjectCreditRow = typeof projectCredit.$inferSelect;

/** A role that changed status under one user: what the counters are moved by. */
export interface ChangedRole {
  userId: string;
  roleCode: string;
  deficitAtJoin: boolean;
}

/** `rewards.project_credit` and `rewards.credit` (FR-REW-01, FR-REW-02); every write is by `RETURNING` (CC-6, CC-12). */
@Injectable()
export class CreditRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** The users whose row was really inserted: a repeated or parallel run inserts nothing and changes no counter. */
  async insertProjectCredits(rows: ProjectCreditInsert[]): Promise<Set<string>> {
    if (rows.length === 0) return new Set();
    const inserted = await this.tx.tx
      .insert(projectCredit)
      .values(rows)
      .onConflictDoNothing()
      .returning({ userId: projectCredit.userId });
    return new Set(inserted.map((r) => r.userId));
  }

  async insertCredits(rows: CreditInsert[]): Promise<CreditRow[]> {
    if (rows.length === 0) return [];
    return this.tx.tx.insert(credit).values(rows).onConflictDoNothing().returning();
  }

  /** Pending rows of the project with the person's own roles. */
  pendingOfTeam(teamId: string): Promise<{ userId: string }[]> {
    return this.tx.tx
      .selectDistinct({ userId: projectCredit.userId })
      .from(projectCredit)
      .where(and(eq(projectCredit.teamId, teamId), eq(projectCredit.status, 'pending_account')));
  }

  /** The teams with a person that waits for his GitHub account, keyset by team id (`project_credit_pending_idx` serves the person side). */
  async pendingTeamIds(after: string | undefined, limit: number): Promise<string[]> {
    const rows = await this.tx.tx
      .selectDistinct({ teamId: projectCredit.teamId })
      .from(projectCredit)
      .where(
        and(
          eq(projectCredit.status, 'pending_account'),
          after === undefined ? undefined : gt(projectCredit.teamId, after),
        ),
      )
      .orderBy(asc(projectCredit.teamId))
      .limit(limit);
    return rows.map((r) => r.teamId);
  }

  /** `pending_account` -> `credited` for the users still pending; `RETURNING` says who really changed. */
  async promote(teamId: string, userIds: string[], at: Date): Promise<ChangedRole[]> {
    if (userIds.length === 0) return [];
    const promoted = await this.tx.tx
      .update(projectCredit)
      .set({ status: 'credited', reason: null, decidedAt: at })
      .where(
        and(
          eq(projectCredit.teamId, teamId),
          inArray(projectCredit.userId, userIds),
          eq(projectCredit.status, 'pending_account'),
        ),
      )
      .returning({ userId: projectCredit.userId });
    const changed = promoted.map((r) => r.userId);
    if (changed.length === 0) return [];
    return this.tx.tx
      .update(credit)
      .set({ status: 'credited', creditedAt: at })
      .where(
        and(
          eq(credit.teamId, teamId),
          inArray(credit.userId, changed),
          eq(credit.status, 'pending_account'),
        ),
      )
      .returning({
        userId: credit.userId,
        roleCode: credit.roleCode,
        deficitAtJoin: credit.deficitAtJoin,
      });
  }

  /**
   * FR-REW-12: `credited` -> `revoked` (the counters go down by exactly these rows), then the pending ones, which
   * never touched a counter. Under lock #11 of the run.
   */
  async revokeRun(teamId: string): Promise<{ users: string[]; roles: ChangedRole[] }> {
    const users = await this.tx.tx
      .update(projectCredit)
      .set({ status: 'revoked' })
      .where(and(eq(projectCredit.teamId, teamId), eq(projectCredit.status, 'credited')))
      .returning({ userId: projectCredit.userId });
    const roles = await this.tx.tx
      .update(credit)
      .set({ status: 'revoked' })
      .where(and(eq(credit.teamId, teamId), eq(credit.status, 'credited')))
      .returning({
        userId: credit.userId,
        roleCode: credit.roleCode,
        deficitAtJoin: credit.deficitAtJoin,
      });
    await this.tx.tx
      .update(projectCredit)
      .set({ status: 'revoked' })
      .where(and(eq(projectCredit.teamId, teamId), eq(projectCredit.status, 'pending_account')));
    await this.tx.tx
      .update(credit)
      .set({ status: 'revoked' })
      .where(and(eq(credit.teamId, teamId), eq(credit.status, 'pending_account')));
    return { users: users.map((u) => u.userId), roles };
  }

  /** Credited roles of the project (the team bonus and `closed deficit` read them). */
  creditedRolesOfTeam(teamId: string): Promise<ChangedRole[]> {
    return this.tx.tx
      .select({
        userId: credit.userId,
        roleCode: credit.roleCode,
        deficitAtJoin: credit.deficitAtJoin,
      })
      .from(credit)
      .where(and(eq(credit.teamId, teamId), eq(credit.status, 'credited')));
  }

  /** The person's own rows of the project, with the reason of the project row. */
  async myCredits(
    teamId: string,
    userId: string,
  ): Promise<{ roleCode: string; status: string; reason: string | null }[]> {
    const rows = await this.tx.tx
      .select({ roleCode: credit.roleCode, status: credit.status, reason: projectCredit.reason })
      .from(credit)
      .innerJoin(
        projectCredit,
        and(eq(projectCredit.teamId, credit.teamId), eq(projectCredit.userId, credit.userId)),
      )
      .where(and(eq(credit.teamId, teamId), eq(credit.userId, userId)))
      .orderBy(asc(credit.roleCode));
    return rows;
  }

  /** The people of the project with a credited or pending row: the ones a recheck or a revocation is about. */
  async stats(userIds: string[]): Promise<Map<string, UserStats>> {
    const result = new Map<string, UserStats>();
    if (userIds.length === 0) return result;
    const [projects, roles, last] = await Promise.all([
      this.tx.tx
        .select({
          userId: projectCredit.userId,
          rosters: sql<number>`count(DISTINCT ${projectCredit.rosterHash})::int`,
          types: sql<number>`count(DISTINCT ${projectCredit.productTypeCode})::int`,
        })
        .from(projectCredit)
        .where(and(inArray(projectCredit.userId, userIds), eq(projectCredit.status, 'credited')))
        .groupBy(projectCredit.userId),
      this.tx.tx
        .select({
          userId: credit.userId,
          roles: sql<number>`count(DISTINCT ${credit.roleCode})::int`,
        })
        .from(credit)
        .where(and(inArray(credit.userId, userIds), eq(credit.status, 'credited')))
        .groupBy(credit.userId),
      this.lastOverdue(userIds),
    ]);
    for (const userId of userIds) {
      const p = projects.find((r) => r.userId === userId);
      result.set(userId, {
        distinctRosters: p?.rosters ?? 0,
        productTypes: p?.types ?? 0,
        roles: roles.find((r) => r.userId === userId)?.roles ?? 0,
        lastOverdue: last.get(userId) ?? [],
      });
    }
    return result;
  }

  /** `overdue_days` of the last three credited projects of each user, newest first (FR-REW-08). */
  private async lastOverdue(userIds: string[]): Promise<Map<string, number[]>> {
    const ranked = this.tx.tx
      .select({
        userId: projectCredit.userId,
        overdueDays: projectCredit.overdueDays,
        completedAt: projectCredit.completedAt,
        rank: sql<number>`row_number() OVER (PARTITION BY ${projectCredit.userId} ORDER BY ${projectCredit.completedAt} DESC, ${projectCredit.teamId} DESC)`.as(
          'rank',
        ),
      })
      .from(projectCredit)
      .where(and(inArray(projectCredit.userId, userIds), eq(projectCredit.status, 'credited')))
      .as('ranked');
    const rows = await this.tx.tx
      .select({ userId: ranked.userId, overdueDays: ranked.overdueDays })
      .from(ranked)
      .where(sql`${ranked.rank} <= 3`)
      .orderBy(asc(ranked.userId), desc(ranked.completedAt));
    const byUser = new Map<string, number[]>();
    for (const row of rows)
      byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.overdueDays]);
    return byUser;
  }

  /** Days since the last project of each user that is credited and is not `exceptTeamId` (AF-22); users without one are absent. */
  async lastOtherCreditAt(userIds: string[], exceptTeamId: string): Promise<Map<string, Date>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.tx.tx
      .select({
        userId: projectCredit.userId,
        at: sql<Date>`max(${projectCredit.decidedAt})`,
      })
      .from(projectCredit)
      .where(
        and(
          inArray(projectCredit.userId, userIds),
          eq(projectCredit.status, 'credited'),
          sql`${projectCredit.teamId} <> ${exceptTeamId}`,
        ),
      )
      .groupBy(projectCredit.userId);
    return new Map(rows.map((r) => [r.userId, new Date(r.at)]));
  }
}
