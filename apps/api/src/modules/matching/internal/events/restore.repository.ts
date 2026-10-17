import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { applicationExclusion, applicationRole } from '../schema/matching.js';

/** Writes of restoring an application after an exclusion (FR-MATCH-08, Р-15). */
@Injectable()
export class RestoreRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** The roles take part in the search again. */
  async activateRoles(applicationId: string): Promise<void> {
    await this.tx.tx
      .update(applicationRole)
      .set({ isActive: true })
      .where(eq(applicationRole.applicationId, applicationId));
  }

  async exclusionsOf(applicationId: string): Promise<string[]> {
    const rows = await this.tx.tx
      .select({ teamId: applicationExclusion.teamId })
      .from(applicationExclusion)
      .where(eq(applicationExclusion.applicationId, applicationId));
    return rows.map((row) => row.teamId);
  }

  /** Idempotent: a team already remembered stays remembered once. */
  async addExclusions(applicationId: string, teamIds: readonly string[]): Promise<void> {
    if (teamIds.length === 0) return;
    await this.tx.tx
      .insert(applicationExclusion)
      .values([...new Set(teamIds)].map((teamId) => ({ applicationId, teamId })))
      .onConflictDoNothing();
  }
}
