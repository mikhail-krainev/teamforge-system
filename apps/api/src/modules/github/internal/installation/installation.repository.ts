import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { ghInstallation, installationGrant } from '../schema/installation.js';

export interface InstallationAccount {
  installationId: number;
  accountId: number;
  accountLogin: string;
  accountType: string;
  status: 'active' | 'suspended';
}

/** Installations and the grants that open them to a team (architecture 5.8, SEC-02). */
@Injectable()
export class InstallationRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** The installation belongs to the account: a later installation by another lead updates the same row. */
  async upsertInstallation(row: InstallationAccount, now: Date): Promise<void> {
    await this.tx.tx
      .insert(ghInstallation)
      .values({ ...row, updatedAt: now })
      .onConflictDoUpdate({
        target: ghInstallation.installationId,
        set: {
          accountId: row.accountId,
          accountLogin: row.accountLogin,
          accountType: row.accountType,
          status: row.status,
          updatedAt: now,
        },
      });
  }

  /**
   * One grant per (installation, team, user). A repeat changes nothing; a revoked grant comes back
   * because the lead has just proved access again.
   */
  async grant(installationId: number, teamId: string, userId: string, now: Date): Promise<void> {
    await this.tx.tx
      .insert(installationGrant)
      .values({ installationId, teamId, userId, grantedAt: now })
      .onConflictDoUpdate({
        target: [
          installationGrant.installationId,
          installationGrant.teamId,
          installationGrant.userId,
        ],
        set: { revokedAt: null, grantedAt: now },
        setWhere: sql`${installationGrant.revokedAt} IS NOT NULL`,
      });
  }

  /** SEC-02: the installation is open to this user for this team only through an unrevoked grant of an installation that still exists. */
  async hasActiveGrant(installationId: number, teamId: string, userId: string): Promise<boolean> {
    const rows = await this.tx.tx
      .select({ installationId: installationGrant.installationId })
      .from(installationGrant)
      .innerJoin(
        ghInstallation,
        eq(ghInstallation.installationId, installationGrant.installationId),
      )
      .where(
        and(
          eq(installationGrant.installationId, installationId),
          eq(installationGrant.teamId, teamId),
          eq(installationGrant.userId, userId),
          isNull(installationGrant.revokedAt),
          ne(ghInstallation.status, 'deleted'),
        ),
      )
      .limit(1);
    return rows.length === 1;
  }

  async exists(installationId: number): Promise<boolean> {
    const rows = await this.tx.tx
      .select({ installationId: ghInstallation.installationId })
      .from(ghInstallation)
      .where(eq(ghInstallation.installationId, installationId))
      .limit(1);
    return rows.length === 1;
  }

  /** The state GitHub reported for the installation (a delivery that GitHub itself confirmed). */
  async setStatus(
    installationId: number,
    status: 'active' | 'suspended' | 'deleted',
    now: Date,
  ): Promise<void> {
    await this.tx.tx
      .update(ghInstallation)
      .set({ status, updatedAt: now })
      .where(eq(ghInstallation.installationId, installationId));
  }

  /** SEC-02: an installation that is gone or suspended opens nothing to anybody; the rows stay as history. */
  async revokeGrants(installationId: number, now: Date): Promise<void> {
    await this.tx.tx
      .update(installationGrant)
      .set({ revokedAt: now })
      .where(
        and(
          eq(installationGrant.installationId, installationId),
          isNull(installationGrant.revokedAt),
        ),
      );
  }
}
