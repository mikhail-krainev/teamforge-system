import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { registerConstraint } from '../../../../platform/errors/constraints.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { applicationRole, searchApplication } from '../schema/matching.js';

// CC-10: the final guard of "one active application per user"; the service checks first.
registerConstraint('search_application_active_uq', { code: 'APPLICATION_EXISTS', status: 409 });

export type ApplicationRow = typeof searchApplication.$inferSelect;
export type ApplicationRoleRow = typeof applicationRole.$inferSelect;

/** `matching.search_application` and `matching.application_role`. */
@Injectable()
export class ApplicationRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  async insert(
    row: typeof searchApplication.$inferInsert,
    roles: (typeof applicationRole.$inferInsert)[],
  ): Promise<void> {
    await this.tx.tx.insert(searchApplication).values(row);
    await this.tx.tx.insert(applicationRole).values(roles);
  }

  async findActiveByUser(userId: string): Promise<ApplicationRow | undefined> {
    const rows = await this.tx.tx
      .select()
      .from(searchApplication)
      .where(and(eq(searchApplication.userId, userId), eq(searchApplication.status, 'active')));
    return rows[0];
  }

  async find(id: string): Promise<ApplicationRow | undefined> {
    const rows = await this.tx.tx
      .select()
      .from(searchApplication)
      .where(eq(searchApplication.id, id));
    return rows[0];
  }

  /** Roles by priority: the order the user ranked them in. */
  listRoles(applicationId: string): Promise<ApplicationRoleRow[]> {
    return this.tx.tx
      .select()
      .from(applicationRole)
      .where(eq(applicationRole.applicationId, applicationId))
      .orderBy(asc(applicationRole.priority));
  }

  async update(id: string, set: Partial<typeof searchApplication.$inferInsert>): Promise<void> {
    await this.tx.tx.update(searchApplication).set(set).where(eq(searchApplication.id, id));
  }

  async deleteRoles(applicationId: string, roleCodes: string[]): Promise<void> {
    if (roleCodes.length === 0) return;
    await this.tx.tx
      .delete(applicationRole)
      .where(
        and(
          eq(applicationRole.applicationId, applicationId),
          inArray(applicationRole.roleCode, roleCodes),
        ),
      );
  }

  /** Priority swaps are legal within a transaction: the unique constraint is deferred. */
  async setPriority(applicationId: string, roleCode: string, priority: number): Promise<void> {
    await this.tx.tx
      .update(applicationRole)
      .set({ priority })
      .where(
        and(
          eq(applicationRole.applicationId, applicationId),
          eq(applicationRole.roleCode, roleCode),
        ),
      );
  }

  async insertRoles(roles: (typeof applicationRole.$inferInsert)[]): Promise<void> {
    if (roles.length === 0) return;
    await this.tx.tx.insert(applicationRole).values(roles);
  }

  async deactivateRoles(applicationId: string): Promise<void> {
    await this.tx.tx
      .update(applicationRole)
      .set({ isActive: false })
      .where(eq(applicationRole.applicationId, applicationId));
  }
}
