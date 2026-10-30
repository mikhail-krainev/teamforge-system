import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { World } from '../../../../../test/fixtures/world.js';
import { barrier, describeInfra } from '../../../../../test/helpers/infra.js';
import { AUTH_API, type AuthApi } from '../../public.js';

const ROUNDS = 20;

describeInfra(
  'S2 deletion saga: two modules report their steps at the same moment (FR-AUTH-09, architecture 13.9)',
  ['db', 'redis'],
  () => {
    let world: World;
    let deadlocksBefore = 0;

    beforeAll(async () => {
      world = await World.start();
      deadlocksBefore = await world.deadlocks();
    });

    afterAll(async () => {
      if (!world) return;
      expect(await world.deadlocks()).toBe(deadlocksBefore);
      expect(world.logs.filter((line) => line.includes('40P01'))).toEqual([]);
      await world.close();
    });

    /** A request whose 72 hours are over and whose saga has started: both modules still owe their step. */
    async function startedRequest(label: string): Promise<{ requestId: string; userId: string }> {
      const person = await world.createUser(label, { consent: false });
      const requestId = randomUUID();
      await world.sql`
        INSERT INTO auth.deletion_request (id, user_id, reason, status, requested_at, scheduled_at, deadline_at)
        VALUES (${requestId}, ${person.id}, 'user_request', 'in_progress',
                now() - interval '73 hours', now() - interval '1 hour', now() + interval '30 days')`;
      return { requestId, userId: person.id };
    }

    it('FR-AUTH-09: profiles, matching and rewards report in parallel, 20 rounds -> every saga completes exactly once', async () => {
      const auth = world.app.get<AuthApi>(AUTH_API);
      const rounds = await Promise.all(
        Array.from({ length: ROUNDS }, (_, i) => startedRequest(`saga-race-${i}`)),
      );

      for (const { requestId } of rounds) {
        // Each round: the two reports start together; the rounds themselves run one after another so
        // that the pair of one saga is the only contention (a pool-wide stampede would hide the race).
        const gate = barrier(3);
        const results = await Promise.allSettled(
          (['profiles', 'matching', 'rewards'] as const).map(async (module) => {
            await gate.wait();
            await auth.reportDeletionStep(requestId, module, { rows: 1 });
          }),
        );
        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
      }

      for (const { requestId, userId } of rounds) {
        const request = await world.sql<{ status: string; completed_at: Date | null }[]>`
          SELECT status, completed_at FROM auth.deletion_request WHERE id = ${requestId}`;
        expect(request[0]?.status, `request ${requestId} is completed`).toBe('completed');
        expect(request[0]?.completed_at).not.toBeNull();
        const steps = await world.sql<{ module: string }[]>`
          SELECT module FROM auth.deletion_step WHERE request_id = ${requestId} ORDER BY module`;
        expect(steps.map((s) => s.module)).toEqual(['matching', 'profiles', 'rewards']);
        const anonymized = await world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM auth.deletion_log
           WHERE request_id = ${requestId} AND module = 'auth' AND action = 'anonymize'`;
        expect(anonymized[0]?.n, 'the final step of auth ran once').toBe(1);
        const user = await world.sql<{ status: string; email: string | null }[]>`
          SELECT status, email FROM auth."user" WHERE id = ${userId}`;
        expect(user[0]).toEqual({ status: 'deleted', email: null });
      }
    });

    it('a module that reports twice does not finish the saga early or twice', async () => {
      const auth = world.app.get<AuthApi>(AUTH_API);
      const { requestId } = await startedRequest('saga-race-repeat');
      const gate = barrier(4);
      await Promise.all(
        (['profiles', 'profiles', 'matching', 'rewards'] as const).map(async (module) => {
          await gate.wait();
          await auth.reportDeletionStep(requestId, module, { rows: 1 });
        }),
      );
      const steps = await world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM auth.deletion_step WHERE request_id = ${requestId}`;
      expect(steps[0]?.n).toBe(3);
      const status = await world.sql<{ status: string }[]>`
        SELECT status FROM auth.deletion_request WHERE id = ${requestId}`;
      expect(status[0]?.status).toBe('completed');
    });
  },
);
