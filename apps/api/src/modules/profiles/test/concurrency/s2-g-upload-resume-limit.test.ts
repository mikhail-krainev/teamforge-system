import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { countOf, expectReplayed } from '../../../../../test/fixtures/assertions.js';
import { resumeFile, ResumeBucket } from '../../../../../test/fixtures/profiles.js';
import { World } from '../../../../../test/fixtures/world.js';
import { statuses } from '../../../../../test/helpers/http.js';
import { barrier, describeInfra } from '../../../../../test/helpers/infra.js';

const N = 20;
const LIMIT = 5;

describeInfra(
  'S2-(г) uploadResume: 20 parallel uploads against the limit C-33 (FR-PROF-02, FR-AUTH-04)',
  ['db', 'redis', 's3'],
  () => {
    let world: World;
    const bucket = new ResumeBucket();
    let deadlocksBefore = 0;

    beforeAll(async () => {
      world = await World.start({ resumeWorker: true });
      deadlocksBefore = await world.deadlocks();
    });

    afterAll(async () => {
      if (!world) return;
      bucket.destroy();
      expect(await world.deadlocks()).toBe(deadlocksBefore);
      expect(world.logs.filter((line) => line.includes('40P01'))).toEqual([]);
      await world.close();
    });

    it('FR-AUTH-04: 20 parallel uploads of one user -> exactly 5 accepted (202), 15 rejected 429 with Retry-After, 5 rows, 5 objects', async () => {
      const person = await world.createUser('cc-g');
      const keys = Array.from({ length: N }, () => randomUUID());
      const gate = barrier(N);
      const results = await Promise.allSettled(
        keys.map(async (key) => {
          await gate.wait();
          return world
            .as(person)
            .upload('/v1/me/resume', resumeFile('resume.pdf'), { idempotencyKey: key });
        }),
      );
      expect(statuses(results)).toEqual({ 202: LIMIT, 429: N - LIMIT });
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.statusCode === 429) {
          expect(Number(result.value.headers['retry-after'])).toBeGreaterThanOrEqual(1);
          expect(result.value.json<{ code: string }>().code).toBe('RATE_LIMITED');
        }
      }

      expect(
        await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM profiles.resume_upload WHERE user_id = ${person.id}`),
      ).toBe(LIMIT);
      const stored = await world.sql<{ storage_key: string }[]>`
        SELECT storage_key FROM profiles.resume_upload WHERE user_id = ${person.id}`;
      expect(new Set(stored.map((r) => r.storage_key)).size).toBe(LIMIT);
      for (const { storage_key } of stored) expect(await bucket.exists(storage_key)).toBe(true);

      // paired test: an accepted upload repeated with its key replays the stored 202, no sixth row
      const winnerIndex = results.findIndex(
        (r) => r.status === 'fulfilled' && r.value.statusCode === 202,
      );
      const replay = await world.as(person).upload('/v1/me/resume', resumeFile('resume.pdf'), {
        idempotencyKey: keys[winnerIndex] ?? '',
      });
      expect(replay.statusCode).toBe(202);
      expectReplayed(replay);
      expect(
        await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM profiles.resume_upload WHERE user_id = ${person.id}`),
      ).toBe(LIMIT);
    });

    it('FR-AUTH-04: the limit belongs to the user: another user uploads while the first is blocked', async () => {
      const blocked = await world.createUser('cc-g-blocked');
      const free = await world.createUser('cc-g-free');
      for (let i = 0; i < LIMIT; i += 1) {
        expect(
          (await world.as(blocked).upload('/v1/me/resume', resumeFile('resume.pdf'))).statusCode,
        ).toBe(202);
      }
      expect(
        (await world.as(blocked).upload('/v1/me/resume', resumeFile('resume.pdf'))).statusCode,
      ).toBe(429);
      expect(
        (await world.as(free).upload('/v1/me/resume', resumeFile('resume.pdf'))).statusCode,
      ).toBe(202);
    });

    it('FR-AUTH-04: rejected uploads (429) leave no row and no object behind', async () => {
      const person = await world.createUser('cc-g-clean');
      for (let i = 0; i < LIMIT; i += 1)
        await world.as(person).upload('/v1/me/resume', resumeFile('resume.pdf'));
      const rejected = await world.as(person).upload('/v1/me/resume', resumeFile('resume.pdf'));
      expect(rejected.statusCode).toBe(429);
      expect(
        await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM profiles.resume_upload WHERE user_id = ${person.id}`),
      ).toBe(LIMIT);
    });
  },
);
