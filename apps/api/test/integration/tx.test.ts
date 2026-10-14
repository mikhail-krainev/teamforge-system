import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../../src/platform/errors/domain-error.js';
import { toProblem } from '../../src/platform/errors/problem.js';
import { LockService } from '../../src/platform/tx/locks.js';
import { TxRunner } from '../../src/platform/tx/tx-runner.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import {
  barrier,
  createTestDatabase,
  describeInfra,
  type TestDatabase,
  waitFor,
} from '../helpers/infra.js';

describeInfra('S1-05 transactions, locks, DB errors (real PostgreSQL)', ['db', 'redis'], () => {
  let db: TestDatabase;
  let testApp: TestApp;
  let runner: TxRunner;
  let locks: LockService;

  beforeAll(async () => {
    db = await createTestDatabase();
    testApp = await createTestApp({ databaseUrl: db.url });
    runner = testApp.app.get(TxRunner);
    locks = testApp.app.get(LockService);
  });

  afterAll(async () => {
    await testApp.close();
    await db.drop();
  });

  const PLAYBOOK_ID = '00000000-0000-7000-8000-0000000a0001';

  async function insertUser(): Promise<string> {
    const id = randomUUID();
    await db.sql`INSERT INTO auth."user" (id, created_at, updated_at) VALUES (${id}, now(), now())`;
    return id;
  }

  function teamInsert(id: string, createdBy: string) {
    return sql`INSERT INTO teams.team (id, name, description, product_type_code, playbook_id, status,
      timezone, hours_per_week, created_by, created_at, updated_at)
      VALUES (${id}::uuid, 'probe', 'probe', 'web_service', ${PLAYBOOK_ID}::uuid, 'forming', 'UTC', 10,
      ${createdBy}::uuid, now(), now())`;
  }

  async function insertTeams(count: number): Promise<string[]> {
    const createdBy = await insertUser();
    const ids = Array.from({ length: count }, () => randomUUID());
    for (const id of ids) {
      await db.sql`INSERT INTO teams.team (id, name, description, product_type_code, playbook_id, status,
        timezone, hours_per_week, created_by, created_at, updated_at)
        VALUES (${id}::uuid, 'probe', 'probe', 'web_service', ${PLAYBOOK_ID}::uuid, 'forming', 'UTC', 10,
        ${createdBy}::uuid, now(), now())`;
    }
    return ids;
  }

  async function insertSeat(teamId: string, ordinal: number): Promise<string> {
    const id = randomUUID();
    await db.sql`INSERT INTO teams.seat (id, team_id, role_code, ordinal, min_level, min_hours, status)
      VALUES (${id}::uuid, ${teamId}::uuid, 'backend', ${ordinal}, 'junior', 10, 'open')`;
    return id;
  }

  it('sets lock_timeout=5s and statement_timeout=10s locally and rolls back on error', async () => {
    const seen = await runner.run(async () => {
      const lock = await runner.tx.execute(sql`SHOW lock_timeout`);
      const statement = await runner.tx.execute(sql`SHOW statement_timeout`);
      return [lock[0]?.lock_timeout, statement[0]?.statement_timeout];
    });
    expect(seen).toEqual(['5s', '10s']);
    const outside = await db.sql`SHOW lock_timeout`;
    expect(outside[0]?.lock_timeout).toBe('0');

    const marker = randomUUID();
    const createdBy = await insertUser();
    await expect(
      runner.run(async () => {
        await runner.tx.execute(teamInsert(marker, createdBy));
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await db.sql`SELECT 1 FROM teams.team WHERE id = ${marker}`).toHaveLength(0);
  });

  it('S1-05: second transaction gets 503 LOCK_TIMEOUT while the row is held', async () => {
    const [teamId] = await insertTeams(1);
    const holder = db.sql.begin(async (tx) => {
      await tx`SELECT id FROM teams.team WHERE id = ${teamId ?? ''} FOR UPDATE`;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const error = await runner
      .run(() => locks.lockTeam(teamId ?? ''), { lockTimeout: '300ms' })
      .catch((e: unknown) => e);
    await holder;
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code: 'LOCK_TIMEOUT', status: 503 });
    expect(toProblem(error, { instance: '/x', requestId: 'r' }).headers['Retry-After']).toBe('1');
  });

  it('S1-05: default 5 s lock_timeout answers HTTP 503 with Retry-After: 1', async () => {
    const id = randomUUID();
    await db.sql`INSERT INTO public.tf_test_versioned (id, value) VALUES (${id}, 'a')`;
    const holder = db.sql.begin(async (tx) => {
      await tx`SELECT id FROM public.tf_test_versioned WHERE id = ${id} FOR UPDATE`;
      await new Promise((resolve) => setTimeout(resolve, 6500));
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const response = await testApp.app.inject({
      method: 'PUT',
      url: `/api/v1/_test/versioned/${id}`,
      headers: { 'x-test-user': randomUUID(), 'idempotency-key': randomUUID() },
      payload: { version: 1, value: 'b' },
    });
    await holder;
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.json()).toMatchObject({ code: 'LOCK_TIMEOUT', status: 503 });
  });

  it('retries a deadlocked transaction (40P01) and both transactions finish', async () => {
    const [a, b] = await insertTeams(2);
    const gate = barrier(2);
    let attempts = 0;
    const crossLock = (first: string, second: string) =>
      runner.run(
        async () => {
          attempts += 1;
          await runner.tx.execute(
            sql`SELECT id FROM teams.team WHERE id = ${first}::uuid FOR UPDATE`,
          );
          await gate.wait();
          await new Promise((resolve) => setTimeout(resolve, 100));
          await runner.tx.execute(
            sql`SELECT id FROM teams.team WHERE id = ${second}::uuid FOR UPDATE`,
          );
          return 'done';
        },
        { jitterMaxMs: 30 },
      );
    const results = await Promise.all([crossLock(a ?? '', b ?? ''), crossLock(b ?? '', a ?? '')]);
    expect(results).toEqual(['done', 'done']);
    expect(attempts).toBeGreaterThan(2);
  });

  it('S1-05: taking a lower lock level after a higher one throws in test mode', async () => {
    const [teamId] = await insertTeams(1);
    const userId = randomUUID();
    await db.sql`INSERT INTO auth."user" (id, created_at, updated_at) VALUES (${userId}, now(), now())`;
    await expect(
      runner.run(async () => {
        await locks.lockTeam(teamId ?? '');
        await locks.lockUser(userId ?? '');
      }),
    ).rejects.toThrow(/Lock order violation: level 1 .* after level 4/);
    const ordered = await runner.run(async () => {
      const user = await locks.lockUser(userId ?? '');
      const team = await locks.lockTeam(teamId ?? '');
      return [user?.id, team?.id];
    });
    expect(ordered).toEqual([userId, teamId]);
  });

  it('locks several seats in ascending id order and rejects locks outside a transaction', async () => {
    const [teamId] = await insertTeams(1);
    const seatIds: string[] = [];
    for (let ordinal = 1; ordinal <= 4; ordinal += 1)
      seatIds.push(await insertSeat(teamId ?? '', ordinal));
    const locked = await runner.run(() => locks.lockSeats([...seatIds].reverse()));
    expect(locked.map((row) => row.id)).toEqual([...seatIds].sort());
    await expect(locks.lockTeam(randomUUID())).rejects.toThrow(/outside a transaction/);
  });

  describe('S1R-05: an attempt that exceeded its deadline rolls back, it never commits later', () => {
    const idleInTransaction = async () =>
      Number(
        (
          await db.sql`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = ${db.name} AND state LIKE 'idle in transaction%'`
        )[0]?.n,
      );
    const effects = async () =>
      Number((await db.sql`SELECT count(*)::int AS n FROM public.tf_test_effect`)[0]?.n);

    it('application pause: 503 now, and the INSERT is rolled back when the scenario resumes', async () => {
      await db.sql`TRUNCATE public.tf_test_effect`;
      const error = await runner
        .run(
          async () => {
            await runner.tx.execute(sql`INSERT INTO public.tf_test_effect (value) VALUES ('late')`);
            await new Promise((resolve) => setTimeout(resolve, 1200));
          },
          { attemptTimeoutMs: 300 },
        )
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'LOCK_TIMEOUT', status: 503 });
      await waitFor(async () => (await idleInTransaction()) === 0);
      expect(await effects()).toBe(0);
    });

    it('busy transaction: statements after the deadline fail, nothing is committed', async () => {
      await db.sql`TRUNCATE public.tf_test_effect`;
      const error = await runner
        .run(
          async () => {
            await runner.tx.execute(sql`SELECT pg_sleep(1)`);
            await runner.tx.execute(sql`INSERT INTO public.tf_test_effect (value) VALUES ('busy')`);
          },
          { attemptTimeoutMs: 300 },
        )
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'LOCK_TIMEOUT', status: 503 });
      await waitFor(async () => (await idleInTransaction()) === 0);
      expect(await effects()).toBe(0);
    });

    it('HTTP: 503 for the client, no effect, no stored idempotency answer', async () => {
      await db.sql`TRUNCATE public.tf_test_effect, platform.idempotency_key`;
      const response = await testApp.app.inject({
        method: 'POST',
        url: '/api/v1/_test/echo',
        headers: { 'x-test-user': randomUUID(), 'idempotency-key': randomUUID() },
        payload: { value: 'slow', delayMs: 1500, attemptTimeoutMs: 300 },
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('1');
      await waitFor(async () => (await idleInTransaction()) === 0);
      expect(await effects()).toBe(0);
      expect(await db.sql`SELECT 1 FROM platform.idempotency_key`).toHaveLength(0);
    });
  });

  it('maps a real 23505 on seat_assignment_active_seat_uq to 409 SEAT_TAKEN', async () => {
    const [teamId] = await insertTeams(1);
    const seatId = await insertSeat(teamId ?? '', 1);
    const people = [await insertUser(), await insertUser()];
    const memberships: string[] = [];
    for (const userId of people) {
      const membershipId = randomUUID();
      memberships.push(membershipId);
      await db.sql`INSERT INTO teams.membership (id, team_id, user_id, status, joined_via, joined_at)
        VALUES (${membershipId}::uuid, ${teamId ?? ''}::uuid, ${userId}::uuid, 'active', 'creator', now())`;
    }
    const insert = (n: number) =>
      runner.run(async () => {
        await runner.tx.execute(
          sql`INSERT INTO teams.seat_assignment (id, seat_id, team_id, membership_id, user_id, role_code,
            joined_via, started_at, deficit_at_join, deficit_open_seats, deficit_queued)
            VALUES (${randomUUID()}::uuid, ${seatId}::uuid, ${teamId ?? ''}::uuid,
            ${memberships[n] ?? ''}::uuid, ${people[n] ?? ''}::uuid, ${`role${n}`}, 'creator', now(),
            false, 0, 0)`,
        );
      });
    await insert(0);
    const error = await insert(1).catch((e: unknown) => e);
    const problem = toProblem(error, { instance: '/x', requestId: 'r' });
    expect(problem.status).toBe(409);
    expect(problem.body.code).toBe('SEAT_TAKEN');
  });
});
