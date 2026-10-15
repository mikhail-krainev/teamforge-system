import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { applicationRole, searchApplication, waitSample } from '../schema/matching.js';
import type { WaitStats } from './demand-rules.js';

/** Reads behind the demand showcase and the deficit rule (no cache here). */
@Injectable()
export class DemandRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** People in the queue per role: rows of active applications (`is_active`), one query. */
  async queuedByRole(roles: string[]): Promise<Map<string, number>> {
    if (roles.length === 0) return new Map();
    const rows = await this.tx.tx
      .select({ roleCode: applicationRole.roleCode, queued: sql<number>`count(*)::int` })
      .from(applicationRole)
      .where(and(inArray(applicationRole.roleCode, roles), eq(applicationRole.isActive, true)))
      .groupBy(applicationRole.roleCode);
    return new Map(rows.map((r) => [r.roleCode, r.queued]));
  }

  /**
   * The queue of one role without one person (FR-MATCH-11): a joiner who is himself queued for
   * the role does not count against the seat he takes. `excludeUserId` undefined counts everyone.
   */
  async queuedForRole(roleCode: string, excludeUserId: string | undefined): Promise<number> {
    const rows = await this.tx.tx
      .select({ queued: sql<number>`count(*)::int` })
      .from(applicationRole)
      .innerJoin(searchApplication, eq(searchApplication.id, applicationRole.applicationId))
      .where(
        and(
          eq(applicationRole.roleCode, roleCode),
          eq(applicationRole.isActive, true),
          excludeUserId === undefined ? undefined : ne(searchApplication.userId, excludeUserId),
        ),
      );
    return rows[0]?.queued ?? 0;
  }

  /** Closed waits since `since` per role (C-41): count and mean, one query. */
  async waitStatsByRole(roles: string[], since: Date): Promise<Map<string, WaitStats>> {
    if (roles.length === 0) return new Map();
    const rows = await this.tx.tx
      .select({
        roleCode: waitSample.roleCode,
        samples: sql<number>`count(*)::int`,
        avgSeconds: sql<number | null>`avg(${waitSample.waitedSeconds})::float8`,
      })
      .from(waitSample)
      .where(and(inArray(waitSample.roleCode, roles), gte(waitSample.matchedAt, since)))
      .groupBy(waitSample.roleCode);
    return new Map(rows.map((r) => [r.roleCode, { samples: r.samples, avgSeconds: r.avgSeconds }]));
  }
}
