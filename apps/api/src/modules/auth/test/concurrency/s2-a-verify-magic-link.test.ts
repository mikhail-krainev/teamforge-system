import { afterAll, beforeAll, expect, it } from 'vitest';
import { tokenLinkOf } from '../../../../../test/fakes/mail.js';
import { countOf, expectProblem } from '../../../../../test/fixtures/assertions.js';
import { randomIp } from '../../../../../test/fixtures/clients.js';
import { World } from '../../../../../test/fixtures/world.js';
import { codes, statuses } from '../../../../../test/helpers/http.js';
import { barrier, describeInfra } from '../../../../../test/helpers/infra.js';

const N = 10;

describeInfra(
  'S2-(а) verifyMagicLink: one token, parallel requests (FR-AUTH-02)',
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

    async function freshToken(label: string): Promise<{ email: string; token: string }> {
      const email = world.email(label);
      const response = await world
        .browser()
        .post('/auth/sign-in/magic-link', { email }, { idempotencyKey: null, ip: randomIp() });
      expect(response.statusCode).toBe(200);
      return { email, token: tokenLinkOf(await world.mail.latestTo(email)).token };
    }

    it('FR-AUTH-02: 10 parallel confirmations of one token -> exactly one 200, nine 401 INVALID_TOKEN, one user, one working session', async () => {
      const { email, token } = await freshToken('cc-a');
      const gate = barrier(N);
      const browsers = Array.from({ length: N }, () => world.browser());
      const results = await Promise.allSettled(
        browsers.map(async (browser) => {
          await gate.wait();
          return browser.post(
            '/auth/magic-link/confirm',
            { token },
            { idempotencyKey: null, ip: randomIp() },
          );
        }),
      );
      expect(statuses(results)).toEqual({ 200: 1, 401: N - 1 });
      expect(new Set(codes(results, 401))).toEqual(new Set(['INVALID_TOKEN']));

      expect(
        await countOf(world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM auth."user" WHERE email = ${email}`),
      ).toBe(1);
      const working = [];
      for (const browser of browsers) {
        if (browser.cookies.size > 0 && (await browser.get('/v1/me')).statusCode === 200)
          working.push(browser);
      }
      expect(working).toHaveLength(1);
    });

    it('FR-AUTH-02: repeating the same confirmation afterwards changes nothing: 401 INVALID_TOKEN, still one user and one session cookie holder', async () => {
      const { email, token } = await freshToken('cc-a-replay');
      const first = world.browser();
      expect(
        (await first.post('/auth/magic-link/confirm', { token }, { idempotencyKey: null }))
          .statusCode,
      ).toBe(200);
      const again = world.browser();
      const replay = await again.post(
        '/auth/magic-link/confirm',
        { token },
        { idempotencyKey: null },
      );
      expectProblem('verifyMagicLink', replay, 401, 'INVALID_TOKEN');
      expect(again.cookies.size).toBe(0);
      expect(
        await countOf(world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM auth."user" WHERE email = ${email}`),
      ).toBe(1);
      expect((await first.get('/v1/me')).statusCode).toBe(200);
    });

    it('FR-AUTH-02: two different tokens of one address confirmed in parallel create one user, not two', async () => {
      const email = world.email('cc-a-two-tokens');
      const tokens: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        await world
          .browser()
          .post('/auth/sign-in/magic-link', { email }, { idempotencyKey: null, ip: randomIp() });
        tokens.push(tokenLinkOf(await world.mail.latestTo(email, { minCount: i + 1 })).token);
      }
      const gate = barrier(2);
      const results = await Promise.allSettled(
        tokens.map(async (token) => {
          await gate.wait();
          return world
            .browser()
            .post('/auth/magic-link/confirm', { token }, { idempotencyKey: null, ip: randomIp() });
        }),
      );
      for (const result of results) {
        expect(result.status === 'fulfilled' ? result.value.statusCode : 0).toBeLessThan(500);
      }
      expect(
        await countOf(world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM auth."user" WHERE email = ${email}`),
      ).toBe(1);
    });
  },
);
