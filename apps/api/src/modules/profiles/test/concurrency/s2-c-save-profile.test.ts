import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { countOf, expectReplayed } from '../../../../../test/fixtures/assertions.js';
import {
  insertProfile,
  PROFILE_ROLES,
  PROFILE_STACK,
  profileInput,
} from '../../../../../test/fixtures/profiles.js';
import { World } from '../../../../../test/fixtures/world.js';
import { codes, statuses } from '../../../../../test/helpers/http.js';
import { barrier, describeInfra } from '../../../../../test/helpers/infra.js';

const N = 20;

describeInfra(
  'S2-(в) saveMyProfile: parallel writes of one version (FR-PROF-01)',
  ['db', 'redis'],
  () => {
    let world: World;
    let deadlocksBefore = 0;

    beforeAll(async () => {
      world = await World.start();
      await world.ensureCatalog(PROFILE_ROLES, PROFILE_STACK);
      deadlocksBefore = await world.deadlocks();
    });

    afterAll(async () => {
      if (!world) return;
      expect(await world.deadlocks()).toBe(deadlocksBefore);
      expect(world.logs.filter((line) => line.includes('40P01'))).toEqual([]);
      await world.close();
    });

    /** Request i differs from every other in name, hours and the number of stack tags. */
    const payload = (i: number, version: number | null) =>
      profileInput({
        displayName: `Racer ${i}`,
        hoursPerWeek: 3 + i,
        stack: PROFILE_STACK.slice(0, (i % PROFILE_STACK.length) + 1),
        version,
      });

    it('FR-PROF-01: 20 parallel saves with version 1 -> one 200, nineteen 409 VERSION_CONFLICT, the profile holds exactly the winner', async () => {
      const person = await world.createUser('cc-c');
      await insertProfile(world.sql, person.id);
      const keys = Array.from({ length: N }, () => randomUUID());
      const gate = barrier(N);
      const results = await Promise.allSettled(
        keys.map(async (key, i) => {
          await gate.wait();
          return world.as(person).put('/v1/me/profile', payload(i, 1), { idempotencyKey: key });
        }),
      );
      expect(statuses(results)).toEqual({ 200: 1, 409: N - 1 });
      expect(codes(results, 409)).toEqual(Array(N - 1).fill('VERSION_CONFLICT'));

      const winnerIndex = results.findIndex(
        (r) => r.status === 'fulfilled' && r.value.statusCode === 200,
      );
      const winner = results[winnerIndex];
      const won =
        winner?.status === 'fulfilled'
          ? winner.value.json<{ version: number; displayName: string }>()
          : null;
      expect(won?.version).toBe(2);
      const row = await world.sql<{ version: number; display_name: string; hours: number }[]>`
      SELECT version, display_name, hours_per_week AS hours FROM profiles.profile WHERE user_id = ${person.id}`;
      expect(row[0]).toMatchObject({
        version: 2,
        display_name: `Racer ${winnerIndex}`,
        hours: 3 + winnerIndex,
      });
      // the children belong to the winner alone: no mix of two writers
      expect(
        await countOf(world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM profiles.profile_stack WHERE user_id = ${person.id}`),
      ).toBe((winnerIndex % PROFILE_STACK.length) + 1);

      const loser = results.find((r) => r.status === 'fulfilled' && r.value.statusCode === 409);
      const current =
        loser?.status === 'fulfilled'
          ? loser.value.json<{ current: { version: number } }>().current
          : null;
      expect(current?.version).toBe(2);

      // paired test: the winner's request repeated with its key replays the stored answer, no second write
      const replay = await world.as(person).put('/v1/me/profile', payload(winnerIndex, 1), {
        idempotencyKey: keys[winnerIndex] ?? '',
      });
      expect(replay.statusCode).toBe(200);
      expectReplayed(replay);
      const after = await world.sql<{ version: number }[]>`
      SELECT version FROM profiles.profile WHERE user_id = ${person.id}`;
      expect(after[0]?.version).toBe(2);
    });

    it('FR-PROF-01: 20 parallel first saves (version null) of a new profile -> one 200, nineteen 409, one profile row', async () => {
      const person = await world.createUser('cc-c-first');
      const gate = barrier(N);
      const results = await Promise.allSettled(
        Array.from({ length: N }, async (_, i) => {
          await gate.wait();
          return world.as(person).put('/v1/me/profile', payload(i, null));
        }),
      );
      expect(statuses(results)).toEqual({ 200: 1, 409: N - 1 });
      expect(
        await countOf(world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM profiles.profile WHERE user_id = ${person.id}`),
      ).toBe(1);
      const row = await world.sql<{ version: number }[]>`
      SELECT version FROM profiles.profile WHERE user_id = ${person.id}`;
      expect(row[0]?.version).toBe(1);
    });

    it('FR-PROF-01: a double click (the same body and the same Idempotency-Key twice at once) writes once', async () => {
      const person = await world.createUser('cc-c-double');
      await insertProfile(world.sql, person.id);
      const key = randomUUID();
      const gate = barrier(2);
      const results = await Promise.all(
        [0, 1].map(async () => {
          await gate.wait();
          return world.as(person).put('/v1/me/profile', payload(0, 1), { idempotencyKey: key });
        }),
      );
      for (const response of results) expect([200, 409]).toContain(response.statusCode);
      expect(results.some((r) => r.statusCode === 200)).toBe(true);
      const row = await world.sql<{ version: number }[]>`
      SELECT version FROM profiles.profile WHERE user_id = ${person.id}`;
      expect(row[0]?.version).toBe(2);
    });

    it('FR-PROF-01: 20 users saving their own profiles at the same time do not interfere', async () => {
      const people = await Promise.all(
        Array.from({ length: N }, (_, i) => world.createUser(`cc-c-many-${i}`)),
      );
      const gate = barrier(N);
      const results = await Promise.all(
        people.map(async (person, i) => {
          await gate.wait();
          return world.as(person).put('/v1/me/profile', payload(i, null));
        }),
      );
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      for (const [i, person] of people.entries()) {
        const row = await world.sql<{ display_name: string }[]>`
        SELECT display_name FROM profiles.profile WHERE user_id = ${person.id}`;
        expect(row[0]?.display_name).toBe(`Racer ${i}`);
      }
    });
  },
);
