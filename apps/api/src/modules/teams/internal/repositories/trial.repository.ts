import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { membership } from '../schema/teams.js';
import type { MembershipRow } from './team.repository.js';

/** Reads and writes of the trial period of a member (`teams.membership`, FR-TEAM-22..24). */
@Injectable()
export class TrialRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** The membership by id, read without a lock (the locks on the team and the membership follow). */
  async find(membershipId: string): Promise<MembershipRow | undefined> {
    const rows = await this.tx.tx.select().from(membership).where(eq(membership.id, membershipId));
    return rows[0];
  }

  /** The active membership of a user in a team, read without a lock. */
  async findActive(teamId: string, userId: string): Promise<MembershipRow | undefined> {
    const rows = await this.tx.tx
      .select()
      .from(membership)
      .where(
        and(
          eq(membership.teamId, teamId),
          eq(membership.userId, userId),
          eq(membership.status, 'active'),
        ),
      );
    return rows[0];
  }

  /** The lead excluded the member in the trial (FR-TEAM-22); the caller holds locks #4 and #6. */
  async markRemovedInTrial(membershipId: string, at: Date): Promise<void> {
    await this.tx.tx
      .update(membership)
      .set({ status: 'removed', leftAt: at, leftReason: 'removed_in_trial' })
      .where(eq(membership.id, membershipId));
  }

  /**
   * The trial is over: confirmed by the lead or ended by the clock (FR-TEAM-24). Only an
   * unconfirmed trial is written, so a repeated call keeps the first moment.
   */
  async confirmTrial(membershipId: string, at: Date): Promise<void> {
    await this.tx.tx
      .update(membership)
      .set({ trialConfirmedAt: at })
      .where(and(eq(membership.id, membershipId), isNull(membership.trialConfirmedAt)));
  }
}
