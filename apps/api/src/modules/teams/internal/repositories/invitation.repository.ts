import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, lt, lte, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { invitation, seat, team } from '../schema/teams.js';

export type InvitationRow = typeof invitation.$inferSelect;
export interface InvitationWithRole {
  invitation: InvitationRow;
  roleCode: string;
}

export interface InvitationCursor {
  at: Date;
  id: string;
}

/** `teams.invitation` (FR-TEAM-08, FR-TEAM-09). The token is only ever looked up by its hash. */
@Injectable()
export class InvitationRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  async insert(row: typeof invitation.$inferInsert): Promise<void> {
    await this.tx.tx.insert(invitation).values(row);
  }

  async find(invitationId: string): Promise<InvitationRow | undefined> {
    const rows = await this.tx.tx.select().from(invitation).where(eq(invitation.id, invitationId));
    return rows[0];
  }

  /** Read without a lock; the row is locked by id afterwards (CC-8: #1 user, then #3 invitation). */
  async findByTokenHash(tokenHash: Buffer): Promise<InvitationRow | undefined> {
    const rows = await this.tx.tx
      .select()
      .from(invitation)
      .where(eq(invitation.tokenHash, tokenHash));
    return rows[0];
  }

  async markUsed(invitationId: string, userId: string, now: Date): Promise<void> {
    await this.tx.tx
      .update(invitation)
      .set({ status: 'used', usedBy: userId, usedAt: now })
      .where(eq(invitation.id, invitationId));
  }

  async setStatus(invitationId: string, status: 'revoked' | 'expired'): Promise<void> {
    await this.tx.tx.update(invitation).set({ status }).where(eq(invitation.id, invitationId));
  }

  async countActive(teamId: string, now: Date): Promise<number> {
    const rows = await this.tx.tx
      .select({ count: sql<number>`count(*)::int` })
      .from(invitation)
      .where(
        and(
          eq(invitation.teamId, teamId),
          eq(invitation.status, 'active'),
          gt(invitation.expiresAt, now),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  /** Newest first, keyset `(created_at, id)`; the role comes from the seat in the same query. */
  listForTeam(
    teamId: string,
    after: InvitationCursor | undefined,
    limit: number,
  ): Promise<InvitationWithRole[]> {
    return this.tx.tx
      .select({ invitation, roleCode: seat.roleCode })
      .from(invitation)
      .innerJoin(seat, eq(seat.id, invitation.seatId))
      .where(
        and(
          eq(invitation.teamId, teamId),
          after === undefined
            ? undefined
            : sql`(${invitation.createdAt}, ${invitation.id}) < (${after.at.toISOString()}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(invitation.createdAt), desc(invitation.id))
      .limit(limit);
  }

  /** Maintenance, step 1: every overdue `active` invitation becomes `expired`. */
  async expireAllOverdue(now: Date): Promise<number> {
    const rows = await this.tx.tx
      .update(invitation)
      .set({ status: 'expired' })
      .where(and(eq(invitation.status, 'active'), lte(invitation.expiresAt, now)))
      .returning({ id: invitation.id });
    return rows.length;
  }

  /** Maintenance, step 2: used, revoked and expired rows older than the cut-off (`invitation_cleanup_idx`). */
  async deleteFinishedBefore(cutoff: Date): Promise<number> {
    const rows = await this.tx.tx
      .delete(invitation)
      .where(and(sql`${invitation.status} <> 'active'`, lt(invitation.createdAt, cutoff)))
      .returning({ id: invitation.id });
    return rows.length;
  }

  /** What the preview shows: team name, product type and the role of the seat. */
  async previewData(
    teamId: string,
    seatId: string,
  ): Promise<{ teamName: string; productTypeCode: string; roleCode: string } | undefined> {
    const rows = await this.tx.tx
      .select({
        teamName: team.name,
        productTypeCode: team.productTypeCode,
        roleCode: seat.roleCode,
      })
      .from(seat)
      .innerJoin(team, eq(team.id, seat.teamId))
      .where(and(eq(team.id, teamId), eq(seat.id, seatId)));
    return rows[0];
  }
}
