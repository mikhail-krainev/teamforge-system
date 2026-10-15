import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, or } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import {
  applicationExclusion,
  applicationRole,
  autoAddLog,
  searchApplication,
  waitSample,
} from '../schema/matching.js';

/** An active application as the auto-add run reads it. */
export interface QueuedApplication {
  id: string;
  userId: string;
  enqueuedAt: Date;
}

/** Keyset position in the queue: the order is `(enqueued_at, id)`. */
export interface QueuePosition {
  enqueuedAt: Date;
  id: string;
}

export interface QueuedRole {
  applicationId: string;
  roleCode: string;
  priority: number;
  addedAt: Date;
}

export type AutoAddLogInsert = typeof autoAddLog.$inferInsert;
export type WaitSampleInsert = typeof waitSample.$inferInsert;

/** Reads and writes of the auto-add run (`matching.auto_add_log`, `matching.wait_sample`, the queue). */
@Injectable()
export class AutoAddRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** Active applications in queue order (the longest waiting first), `limit` after `after`. */
  activeApplications(after: QueuePosition | undefined, limit: number): Promise<QueuedApplication[]> {
    return this.tx.tx
      .select({
        id: searchApplication.id,
        userId: searchApplication.userId,
        enqueuedAt: searchApplication.enqueuedAt,
      })
      .from(searchApplication)
      .where(
        and(
          eq(searchApplication.status, 'active'),
          after === undefined
            ? undefined
            : or(
                gt(searchApplication.enqueuedAt, after.enqueuedAt),
                and(
                  eq(searchApplication.enqueuedAt, after.enqueuedAt),
                  gt(searchApplication.id, after.id),
                ),
              ),
        ),
      )
      .orderBy(asc(searchApplication.enqueuedAt), asc(searchApplication.id))
      .limit(limit);
  }

  /** Roles that still take part in the search, of several applications (one statement). */
  async activeRoles(applicationIds: string[]): Promise<Map<string, QueuedRole[]>> {
    const byApplication = new Map<string, QueuedRole[]>();
    if (applicationIds.length === 0) return byApplication;
    const rows = await this.tx.tx
      .select({
        applicationId: applicationRole.applicationId,
        roleCode: applicationRole.roleCode,
        priority: applicationRole.priority,
        addedAt: applicationRole.addedAt,
      })
      .from(applicationRole)
      .where(
        and(
          inArray(applicationRole.applicationId, applicationIds),
          eq(applicationRole.isActive, true),
        ),
      )
      .orderBy(asc(applicationRole.priority));
    for (const row of rows) {
      const list = byApplication.get(row.applicationId) ?? [];
      list.push(row);
      byApplication.set(row.applicationId, list);
    }
    return byApplication;
  }

  /** Teams that excluded the candidate in the trial period, per application. */
  async exclusions(applicationIds: string[]): Promise<Map<string, Set<string>>> {
    const byApplication = new Map<string, Set<string>>();
    if (applicationIds.length === 0) return byApplication;
    const rows = await this.tx.tx
      .select()
      .from(applicationExclusion)
      .where(inArray(applicationExclusion.applicationId, applicationIds));
    for (const row of rows) {
      const teams = byApplication.get(row.applicationId) ?? new Set<string>();
      teams.add(row.teamId);
      byApplication.set(row.applicationId, teams);
    }
    return byApplication;
  }

  async isExcluded(applicationId: string, teamId: string): Promise<boolean> {
    const rows = await this.tx.tx
      .select({ teamId: applicationExclusion.teamId })
      .from(applicationExclusion)
      .where(
        and(
          eq(applicationExclusion.applicationId, applicationId),
          eq(applicationExclusion.teamId, teamId),
        ),
      );
    return rows.length > 0;
  }

  async insertWaitSample(row: WaitSampleInsert): Promise<void> {
    await this.tx.tx.insert(waitSample).values(row);
  }

  async insertLog(row: AutoAddLogInsert): Promise<void> {
    await this.tx.tx.insert(autoAddLog).values(row);
  }
}
