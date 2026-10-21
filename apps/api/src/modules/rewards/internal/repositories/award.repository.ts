import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { award, badgeDef } from '../schema/rewards.js';

export interface NewAward {
  userId: string;
  badgeCode: string;
  scope: 'individual' | 'team';
  teamId: string;
  awardedAt: Date;
}

export interface AwardedBadge {
  userId: string;
  badgeCode: string;
  teamId: string | null;
}

export type BadgeRow = typeof badgeDef.$inferSelect;

/** `rewards.award` and the catalog `rewards.badge_def` (FR-REW-05, FR-REW-06). */
@Injectable()
export class AwardRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** Codes of the badges that can be granted now (a seed row with `available = false` never is). */
  async availableCodes(): Promise<Set<string>> {
    const rows = await this.tx.tx
      .select({ code: badgeDef.code })
      .from(badgeDef)
      .where(eq(badgeDef.available, true));
    return new Set(rows.map((r) => r.code));
  }

  /**
   * `ON CONFLICT DO NOTHING` on `award_individual_uq` and `award_team_uq`: a repeated run or a parallel one gives
   * no duplicate. Returns only the rows that were really inserted. Rows go in a fixed order against deadlocks.
   */
  async insertMany(rows: NewAward[]): Promise<AwardedBadge[]> {
    if (rows.length === 0) return [];
    const sorted = [...rows].sort(
      (a, b) => a.userId.localeCompare(b.userId) || a.badgeCode.localeCompare(b.badgeCode),
    );
    return this.tx.tx
      .insert(award)
      .values(sorted.map((r) => ({ id: uuidv7(), ...r })))
      .onConflictDoNothing()
      .returning({ userId: award.userId, badgeCode: award.badgeCode, teamId: award.teamId });
  }

  /** FR-REW-12: the awards a project gave are revoked, once (`revoked_at IS NULL` in the condition). */
  revokeOfTeam(teamId: string, reason: string, at: Date): Promise<AwardedBadge[]> {
    return this.tx.tx
      .update(award)
      .set({ revokedAt: at, revokeReason: reason })
      .where(and(eq(award.teamId, teamId), isNull(award.revokedAt)))
      .returning({ userId: award.userId, badgeCode: award.badgeCode, teamId: award.teamId });
  }

  /** The active awards of a person with the catalog entry; newest first. */
  listActive(userId: string): Promise<
    {
      badgeCode: string;
      name: string;
      series: string | null;
      step: number | null;
      teamId: string | null;
      awardedAt: Date;
    }[]
  > {
    return this.tx.tx
      .select({
        badgeCode: award.badgeCode,
        name: badgeDef.name,
        series: badgeDef.series,
        step: badgeDef.step,
        teamId: award.teamId,
        awardedAt: award.awardedAt,
      })
      .from(award)
      .innerJoin(badgeDef, eq(badgeDef.code, award.badgeCode))
      .where(and(eq(award.userId, userId), isNull(award.revokedAt)))
      .orderBy(desc(award.awardedAt), asc(badgeDef.code));
  }

  /** The whole catalog, in the order of the steps. */
  catalog(): Promise<BadgeRow[]> {
    return this.tx.tx
      .select()
      .from(badgeDef)
      .orderBy(asc(badgeDef.scope), asc(badgeDef.series), asc(badgeDef.step), asc(badgeDef.code));
  }
}
