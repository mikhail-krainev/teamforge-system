import { afterAll, beforeAll, expect, it } from 'vitest';
import { githubIdentity } from '../../../../../test/fakes/github-server.js';
import { countOf } from '../../../../../test/fixtures/assertions.js';
import { World } from '../../../../../test/fixtures/world.js';
import { barrier, describeInfra } from '../../../../../test/helpers/infra.js';
import { beginGithub, callbackOutcome, finishGithub } from '../github-flow.js';

const N = 20;

describeInfra(
  'S2-(б) linkGithub: one GitHub account, parallel users (FR-AUTH-05)',
  ['db', 'redis'],
  () => {
    let world: World;
    let deadlocksBefore = 0;

    beforeAll(async () => {
      world = await World.start({ github: true });
      deadlocksBefore = await world.deadlocks();
    });

    afterAll(async () => {
      if (!world) return;
      expect(await world.deadlocks()).toBe(deadlocksBefore);
      expect(world.logs.filter((line) => line.includes('40P01'))).toEqual([]);
      await world.close();
    });

    const linked = (githubId: number) =>
      countOf(world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM auth."user" WHERE github_user_id = ${githubId}`);

    async function prepare(count: number, label: string) {
      const identity = githubIdentity(`${label}-${world.runId}`);
      const people = await Promise.all(
        Array.from({ length: count }, (_, i) => world.signedIn(`${label}-${i}`)),
      );
      const flows = await Promise.all(
        people.map(async (person) => ({
          ...person,
          begin: await beginGithub(person.session, 'link'),
        })),
      );
      return { identity, flows };
    }

    it('FR-AUTH-05: 2 users complete linking the same GitHub account in parallel -> exactly one succeeds', async () => {
      const { identity, flows } = await prepare(2, 'cc-b2');
      const gate = barrier(2);
      const results = await Promise.all(
        flows.map(async (flow) => {
          await gate.wait();
          return finishGithub(world, flow.session, flow.begin.authorizeUrl, identity);
        }),
      );
      expect(results.map(callbackOutcome).sort()).toEqual(['already-linked', 'ok']);
      expect(await linked(identity.id)).toBe(1);
    });

    it('FR-AUTH-05: 20 users complete linking the same GitHub account in parallel -> one success, 19 GITHUB_ALREADY_LINKED, one owner in the database', async () => {
      const { identity, flows } = await prepare(N, 'cc-b');
      const gate = barrier(N);
      const results = await Promise.all(
        flows.map(async (flow) => {
          await gate.wait();
          return finishGithub(world, flow.session, flow.begin.authorizeUrl, identity);
        }),
      );
      const outcomes = results.map(callbackOutcome);
      expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'already-linked')).toHaveLength(N - 1);

      expect(await linked(identity.id)).toBe(1);
      expect(
        await countOf(world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM auth.account
         WHERE provider_id = 'github' AND account_id = ${String(identity.id)}`),
      ).toBe(1);
      const winner = flows[outcomes.indexOf('ok')];
      const owner = await world.sql<{ id: string }[]>`
      SELECT id FROM auth."user" WHERE github_user_id = ${identity.id}`;
      expect(owner[0]?.id).toBe(winner?.user.id);
    });

    it('FR-AUTH-05: repeating a finished flow (same callback, or linking the same account again) creates no second link', async () => {
      const { identity, flows } = await prepare(2, 'cc-b-replay');
      const [first, second] = flows;
      if (!first || !second) throw new Error('fixtures');
      expect(
        callbackOutcome(
          await finishGithub(world, first.session, first.begin.authorizeUrl, identity),
        ),
      ).toBe('ok');
      // the same user links the same account again: accepted or refused, never duplicated
      const again = await beginGithub(first.session, 'link');
      await finishGithub(world, first.session, again.authorizeUrl, identity);
      // another user tries with the first flow's URL after the fact
      const late = await finishGithub(world, second.session, second.begin.authorizeUrl, identity);
      expect(callbackOutcome(late)).toBe('already-linked');
      expect(await linked(identity.id)).toBe(1);
      expect(
        await countOf(world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM auth.account
         WHERE provider_id = 'github' AND account_id = ${String(identity.id)}`),
      ).toBe(1);
    });

    it('FR-AUTH-01: 20 parallel first sign-ins with one GitHub account create exactly one user', async () => {
      const identity = githubIdentity(`cc-b-signin-${world.runId}`);
      const browsers = Array.from({ length: N }, () => world.browser());
      const begins = await Promise.all(browsers.map((b) => beginGithub(b, 'sign-in')));
      const gate = barrier(N);
      const results = await Promise.all(
        browsers.map(async (browser, i) => {
          await gate.wait();
          return finishGithub(world, browser, begins[i]?.authorizeUrl ?? '', identity);
        }),
      );
      for (const result of results) expect(result.statusCode).toBeLessThan(500);
      expect(await linked(identity.id)).toBe(1);
      expect(
        await countOf(world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM auth.account
         WHERE provider_id = 'github' AND account_id = ${String(identity.id)}`),
      ).toBe(1);
    });
  },
);
