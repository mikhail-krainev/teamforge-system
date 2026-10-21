import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { counter, projectCredit } from '../schema/rewards.js';

/** A change of one counter: `roleCode` null is the total of credited projects. */
export interface CounterDelta {
  userId: string;
  roleCode: string | null;
  delta: number;
}

export interface CounterValue {
  userId: string;
  roleCode: string | null;
  value: number;
}

const byKey = (a: CounterDelta, b: CounterDelta): number =>
  a.userId.localeCompare(b.userId) || (a.roleCode ?? '').localeCompare(b.roleCode ?? '');

/** One delta per counter, in the fixed order (an upsert may not touch one row twice). */
function merged(deltas: CounterDelta[]): CounterDelta[] {
  const sums = new Map<string, CounterDelta>();
  for (const d of deltas) {
    const key = `${d.userId}|${d.roleCode ?? ''}|${d.roleCode === null ? 'total' : 'role'}`;
    const known = sums.get(key);
    sums.set(key, known === undefined ? { ...d } : { ...known, delta: known.delta + d.delta });
  }
  return [...sums.values()].sort(byKey);
}

/** `rewards.counter` (FR-REW-04). Rows are touched in one fixed order, so two credits of one person do not deadlock. */
@Injectable()
export class CounterRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  /** `value + delta` by upsert; returns the values after the change. Only inserted credit rows come here (CC-6). */
  async increase(deltas: CounterDelta[]): Promise<CounterValue[]> {
    if (deltas.length === 0) return [];
    const sorted = merged(deltas);
    return this.tx.tx
      .insert(counter)
      .values(sorted.map((d) => ({ userId: d.userId, roleCode: d.roleCode, value: d.delta })))
      .onConflictDoUpdate({
        target: [counter.userId, counter.roleCode],
        set: { value: sql`${counter.value} + excluded.value` },
      })
      .returning({ userId: counter.userId, roleCode: counter.roleCode, value: counter.value });
  }

  /** `value - delta` for rows that were really revoked (`RETURNING` of the revocation); never below zero by the CHECK. */
  async decrease(deltas: CounterDelta[]): Promise<CounterValue[]> {
    if (deltas.length === 0) return [];
    const sorted = merged(deltas);
    const values: SQL[] = sorted.map(
      (d) => sql`(${d.userId}::uuid, ${d.roleCode}::text, ${d.delta}::int)`,
    );
    const rows = await this.tx.tx.execute(sql`
      UPDATE rewards.counter AS c SET value = c.value - v.delta
        FROM (VALUES ${sql.join(values, sql`, `)}) AS v(user_id, role_code, delta)
       WHERE c.user_id = v.user_id AND c.role_code IS NOT DISTINCT FROM v.role_code
   RETURNING c.user_id AS "userId", c.role_code AS "roleCode", c.value AS "value"`);
    return [...rows] as unknown as CounterValue[];
  }

  /** The non-zero counters of the users, total and per role. */
  listOf(userIds: string[]): Promise<CounterValue[]> {
    if (userIds.length === 0) return Promise.resolve([]);
    return this.tx.tx
      .select({ userId: counter.userId, roleCode: counter.roleCode, value: counter.value })
      .from(counter)
      .where(and(inArray(counter.userId, userIds), gt(counter.value, 0)))
      .orderBy(asc(counter.userId), asc(counter.roleCode));
  }

  /** Product types of the credited projects of the user. */
  async productTypes(userId: string): Promise<string[]> {
    const rows = await this.tx.tx
      .selectDistinct({ code: projectCredit.productTypeCode })
      .from(projectCredit)
      .where(and(eq(projectCredit.userId, userId), eq(projectCredit.status, 'credited')))
      .orderBy(asc(projectCredit.productTypeCode));
    return rows.map((r) => r.code);
  }

  /** The total counter row of the user, or `undefined`. */
  async total(userId: string): Promise<number> {
    const [row] = await this.tx.tx
      .select({ value: counter.value })
      .from(counter)
      .where(and(eq(counter.userId, userId), isNull(counter.roleCode)));
    return row?.value ?? 0;
  }
}
