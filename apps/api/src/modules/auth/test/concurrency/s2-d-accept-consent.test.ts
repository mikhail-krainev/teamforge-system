import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { countOf, expectReplayed } from '../../../../../test/fixtures/assertions.js';
import { World } from '../../../../../test/fixtures/world.js';
import { statuses } from '../../../../../test/helpers/http.js';
import { barrier, describeInfra } from '../../../../../test/helpers/infra.js';

const N = 10;

describeInfra(
  'S2-(д) acceptConsent: parallel requests with different keys (FR-AUTH-03)',
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

    const rows = (userId: string, version: string) =>
      countOf(world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM auth.consent
       WHERE user_id = ${userId} AND version = ${version} AND revoked_at IS NULL`);

    it('FR-AUTH-03: 10 parallel acceptances with 10 different Idempotency-Keys -> one consent record of this version', async () => {
      const person = await world.createUser('cc-d', { consent: false });
      const { version, textHash } = await world.currentConsent();
      const gate = barrier(N);
      const results = await Promise.allSettled(
        Array.from({ length: N }, async () => {
          await gate.wait();
          return world.as(person).post('/v1/me/consents', { version, textHash });
        }),
      );
      const counts = statuses(results);
      expect(counts[201] ?? 0).toBeGreaterThanOrEqual(1);
      expect(Object.keys(counts).every((s) => [200, 201, 409].includes(Number(s)))).toBe(true);
      expect(await rows(person.id, version)).toBe(1);
    });

    it('FR-AUTH-03: the winner repeated with the same Idempotency-Key replays the stored 201 and adds no record', async () => {
      const person = await world.createUser('cc-d-replay', { consent: false });
      const { version, textHash } = await world.currentConsent();
      const key = randomUUID();
      const gate = barrier(N);
      const results = await Promise.all(
        Array.from({ length: N }, async () => {
          await gate.wait();
          return world
            .as(person)
            .post('/v1/me/consents', { version, textHash }, { idempotencyKey: key });
        }),
      );
      // one key: one execution, the others wait (409 IDEMPOTENCY_IN_PROGRESS) or replay the result
      for (const response of results) expect([201, 409]).toContain(response.statusCode);
      const replay = await world
        .as(person)
        .post('/v1/me/consents', { version, textHash }, { idempotencyKey: key });
      expect(replay.statusCode).toBe(201);
      expectReplayed(replay);
      expect(await rows(person.id, version)).toBe(1);
    });

    it('FR-AUTH-03: acceptances of 20 different users in parallel each leave exactly one record', async () => {
      const people = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          world.createUser(`cc-d-many-${i}`, { consent: false }),
        ),
      );
      const { version, textHash } = await world.currentConsent();
      const gate = barrier(people.length);
      const results = await Promise.all(
        people.map(async (person) => {
          await gate.wait();
          return world.as(person).post('/v1/me/consents', { version, textHash });
        }),
      );
      expect(results.every((r) => r.statusCode === 201)).toBe(true);
      for (const person of people) expect(await rows(person.id, version)).toBe(1);
    });
  },
);
