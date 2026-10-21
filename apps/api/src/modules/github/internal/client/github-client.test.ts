import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  availableRepositories,
  github,
  installApp,
  repoSpec,
} from '../../../../../test/fixtures/github.js';
import { expectOk } from '../../../../../test/fixtures/teams.js';
import { routeTeam, startRouteWorld } from '../../../../../test/fixtures/workspace.js';
import type { World } from '../../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../../test/helpers/clock.js';
import { describeInfra, scanKeys } from '../../../../../test/helpers/infra.js';

const MINUTE_MS = 60_000;

/**
 * S6-03: tokens of installations (architecture 7.5) against the GitHub App double: one token serves
 * many requests, it waits in Redis sealed and for less than an hour, and a token that GitHub refuses
 * or that is about to expire is replaced.
 */
describeInfra(
  'S6 github client: installation tokens in Redis (FR-GH-01, 7.5)',
  ['db', 'redis'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());
    let redis: Redis;

    beforeAll(async () => {
      world = await startRouteWorld({ github: true, clock });
      redis = new Redis(process.env.REDIS_URL ?? '', { maxRetriesPerRequest: null });
    });

    afterAll(async () => {
      redis?.disconnect();
      if (world) await world.close();
    });

    const connected = async () => {
      const fx = await routeTeam(world);
      const installed = await installApp(world, fx.lead, fx.team.id, { repos: [repoSpec([])] });
      const list = async (): Promise<void> => {
        expectOk(
          'listAvailableRepositories',
          await availableRepositories(world, fx.lead, fx.team.id, installed.installation.id),
          200,
        );
      };
      return { installationId: installed.installation.id, list };
    };

    it('FR-GH-01: one token serves the next requests, it is sealed in Redis and expires within 55 minutes', async () => {
      const { installationId, list } = await connected();
      await list();
      await list();
      await list();
      expect(github(world).app.tokensIssued(installationId)).toBe(1);
      const key = `gh_inst_token:${installationId}`;
      const stored = await redis.get(key);
      expect(stored).toMatch(/^v1:/); // AES-256-GCM envelope of SecretBox, not the token itself
      const issued = github(world).app.tokens.keys();
      for (const token of issued) expect(stored).not.toContain(token);
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(55 * 60);
      const rows =
        await world.sql`SELECT count(*)::int AS n FROM auth.account WHERE access_token LIKE 'ghs_%'`;
      expect(rows[0]?.['n']).toBe(0);
    });

    it('FR-GH-01: a token that GitHub no longer accepts is replaced once and the request succeeds', async () => {
      const { installationId, list } = await connected();
      await list();
      github(world).app.tokens.clear(); // revoked on GitHub while the cache still holds it
      await list();
      expect(github(world).app.tokensIssued(installationId)).toBe(2);
    });

    it('FR-GH-01: a cached token that expires within a minute is not used', async () => {
      const { installationId, list } = await connected();
      await list();
      clock.advance(59 * MINUTE_MS + 30_000);
      await list();
      expect(github(world).app.tokensIssued(installationId)).toBe(2);
    });

    it('SEC-07: no key of the token cache outlives its prefix: only gh_inst_token:<installationId> is written', async () => {
      const { installationId, list } = await connected();
      await list();
      const keys = await scanKeys(redis, 'gh_inst_token:*');
      expect(keys).toContain(`gh_inst_token:${installationId}`);
      expect(keys.every((key) => /^gh_inst_token:\d+$/.test(key))).toBe(true);
    });
  },
);
