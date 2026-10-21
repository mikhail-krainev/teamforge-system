import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, logLinesWith } from '../../../../test/fixtures/assertions.js';
import {
  availableRepositories,
  callback,
  createSession,
  expectSetupRefused,
  ghPerson,
  github,
  installApp,
  personalAccount,
  repoSpec,
  setupUrl,
  startSession,
  stateOf,
  type AvailableRepositoryListDto,
  type InstallationSessionDto,
} from '../../../../test/fixtures/github.js';
import { activeGrantCount, grantRows } from '../../../../test/fixtures/github-db.js';
import { expectReplayed } from '../../../../test/fixtures/assertions.js';
import { expectOk, githubUser } from '../../../../test/fixtures/teams.js';
import {
  routeTeam,
  startRouteWorld,
  type RouteFixture,
} from '../../../../test/fixtures/workspace.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, scanKeys } from '../../../../test/helpers/infra.js';

/*
 * S6-02: installation of the GitHub App (FR-GH-01, FR-GH-10; architecture 7.2, SEC-02), written before
 * the implementation: createInstallationSession, githubSetupCallback and listAvailableRepositories
 * against the GitHub App double. The flow is the one confirmed by the S6-01 prototype
 * (docs/research/github-state-spike.md): a one-time `state` bound to the user and the team, a `code`
 * that proves who installed, `GET /user/installations`, then the grant (installation, team, user).
 * Where the plan allows both a redirect with `?error=` and 400/403 for a refusal, both are accepted;
 * what is never accepted is a grant that should not exist.
 */

const STATE_TTL_SECONDS = 600;
const MIN_STATE_LENGTH = 43; // 32 random bytes in base64url

describeInfra(
  'S6 github: installation of the App, one-time state, grants (FR-GH-01, FR-GH-10, SEC-02)',
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
      if (!world) return;
      await world.close();
    });

    const newTeam = (): Promise<RouteFixture> => routeTeam(world);

    describe('createInstallationSession (FR-GH-01)', () => {
      it('FR-GH-01: the lead gets an install URL of the App with a one-time state that lives 10 minutes', async () => {
        const fx = await newTeam();
        const response = await createSession(world, fx.lead, fx.team.id);
        const session = expectOk<InstallationSessionDto>(
          'createInstallationSession',
          response,
          201,
        );
        const url = new URL(session.installUrl);
        expect(url.origin).toBe('https://github.com');
        expect(url.pathname).toBe(`/apps/${github(world).app.slug}/installations/new`);
        const state = stateOf(session);
        expect(state).toMatch(/^[A-Za-z0-9_-]+$/); // base64url: no ':' that could name a cache key
        expect(state.length).toBeGreaterThanOrEqual(MIN_STATE_LENGTH);
        const expires = Date.parse(session.expiresAt) - clock.now().getTime();
        expect(Math.abs(expires - STATE_TTL_SECONDS * 1000)).toBeLessThan(15_000);
        const keys = await scanKeys(redis, 'gh_state:*');
        expect(keys.length).toBeGreaterThan(0);
        const ttls = await Promise.all(keys.map((key) => redis.ttl(key)));
        expect(ttls.some((ttl) => ttl > 0 && ttl <= STATE_TTL_SECONDS)).toBe(true);
      });

      it('FR-GH-01: every call gives a different state (it is never reused or guessable)', async () => {
        const fx = await newTeam();
        const states = new Set<string>();
        for (let i = 0; i < 5; i += 1)
          states.add((await startSession(world, fx.lead, fx.team.id)).state);
        expect(states.size).toBe(5);
      });

      it('FR-GH-01: a repeat with the same Idempotency-Key returns the stored answer, not a second state', async () => {
        const fx = await newTeam();
        const key = randomUUID();
        const first = await createSession(world, fx.lead, fx.team.id, key);
        const second = await createSession(world, fx.lead, fx.team.id, key);
        expect(first.statusCode).toBe(201);
        expectReplayed(second);
        expect(second.json()).toEqual(first.json());
      });

      it('FR-GH-01: a member who is not the lead gets 403 NOT_TEAM_LEAD and no state is issued', async () => {
        const fx = await newTeam();
        const before = (await scanKeys(redis, 'gh_state:*')).length;
        expectProblem(
          'createInstallationSession',
          await createSession(world, fx.backend, fx.team.id),
          403,
          'NOT_TEAM_LEAD',
        );
        expect((await scanKeys(redis, 'gh_state:*')).length).toBe(before);
      });

      it('SEC-03: an outsider and a foreign team look the same: 404', async () => {
        const fx = await newTeam();
        const other = await newTeam();
        const stranger = await githubUser(world, 'stranger');
        expectProblem(
          'createInstallationSession',
          await createSession(world, stranger, fx.team.id),
          404,
          'NOT_FOUND',
        );
        expectProblem(
          'createInstallationSession',
          await createSession(world, other.lead, fx.team.id),
          404,
          'NOT_FOUND',
        );
      });
    });

    describe('githubSetupCallback (FR-GH-01, SEC-02)', () => {
      it('FR-GH-01: state, code and ownership match -> redirect with the installation, one grant for (installation, team, lead)', async () => {
        const fx = await newTeam();
        const { installation } = await installApp(world, fx.lead, fx.team.id);
        const grants = await grantRows(world, installation.id);
        expect(grants).toHaveLength(1);
        expect(grants[0]).toMatchObject({
          team_id: fx.team.id,
          user_id: fx.lead.id,
          revoked_at: null,
        });
        const [row] = await world.sql<
          { account_login: string; status: string; account_type: string }[]
        >`
          SELECT account_login, status, account_type FROM github.gh_installation
           WHERE installation_id = ${installation.id}`;
        expect(row).toMatchObject({
          account_login: installation.account.login,
          status: 'active',
          account_type: 'User',
        });
      });

      it('FR-GH-10: the user token of the exchange is dropped: not logged, not stored; neither are state and code', async () => {
        const fx = await newTeam();
        const { query } = await installApp(world, fx.lead, fx.team.id);
        const secrets = [query.code, query.state, ...github(world).issued.accessTokens].filter(
          (value): value is string => Boolean(value),
        );
        for (const secret of secrets) {
          expect(logLinesWith(world.logs, secret), `log line with ${secret.slice(0, 6)}…`).toEqual(
            [],
          );
          const [stored] = await world.sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM auth.account
             WHERE access_token = ${secret} OR refresh_token = ${secret}`;
          expect(stored?.n).toBe(0);
        }
      });

      it('FR-GH-01: state is single use: the same redirect again is refused and there is still one grant', async () => {
        const fx = await newTeam();
        const { installation, query } = await installApp(world, fx.lead, fx.team.id);
        const replay = await callback(world, fx.lead, query);
        expectSetupRefused(replay, world);
        expect(await grantRows(world, installation.id)).toHaveLength(1);
      });

      it('SEC-02: a state of another user is refused (400/403 or ?error), no grant, and the state is burned', async () => {
        const fx = await newTeam();
        const thief = await githubUser(world, 'thief');
        const { state } = await startSession(world, fx.lead, fx.team.id);
        const person = await ghPerson(world, fx.lead);
        const result = github(world).app.install(person, personalAccount(person), { state });
        const stolen = await callback(world, thief, result.query);
        expectSetupRefused(stolen, world);
        expect(await activeGrantCount(world, fx.team.id)).toBe(0);
        const owner = await callback(world, fx.lead, result.query);
        expectSetupRefused(owner, world); // the owner has to start again
        expect(await activeGrantCount(world, fx.team.id)).toBe(0);
      });

      it.each([
        ['an unknown state', (): string => 'nonexistentstate'],
        [
          'a state with a colon (it could name a cache key)',
          (): string => 'gh_state:cache:login:someone',
        ],
        ['an empty state', (): string => ''],
      ])('SEC-02: %s is refused and nothing is granted', async (_title, state) => {
        const fx = await newTeam();
        const person = await ghPerson(world, fx.lead);
        const result = github(world).app.install(person, personalAccount(person), {
          state: state(),
        });
        const response = await callback(world, fx.lead, { ...result.query, state: state() });
        expectSetupRefused(response, world);
        expect(await activeGrantCount(world, fx.team.id)).toBe(0);
      });

      it('SEC-02: an expired state (older than 10 minutes) is refused', async () => {
        const fx = await newTeam();
        const { state } = await startSession(world, fx.lead, fx.team.id);
        const keys = await scanKeys(redis, 'gh_state:*');
        for (const key of keys) if ((await redis.ttl(key)) > 0) await redis.pexpire(key, 1);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const person = await ghPerson(world, fx.lead);
        const result = github(world).app.install(person, personalAccount(person), { state });
        expectSetupRefused(await callback(world, fx.lead, result.query), world);
        expect(await activeGrantCount(world, fx.team.id)).toBe(0);
      });

      it('SEC-02: without a code nothing proves who installed: refused, no grant', async () => {
        const fx = await newTeam();
        const { state } = await startSession(world, fx.lead, fx.team.id);
        const person = await ghPerson(world, fx.lead);
        const result = github(world).app.install(person, personalAccount(person), { state });
        const withoutCode: Record<string, string> = { ...result.query };
        delete withoutCode.code;
        expectSetupRefused(await callback(world, fx.lead, withoutCode), world);
        expect(await activeGrantCount(world, fx.team.id)).toBe(0);
      });

      it('SEC-02: a forged installation_id (an installation of somebody else) is refused although state and code are good', async () => {
        const fx = await newTeam();
        const victim = await githubUser(world, 'victim');
        const victimPerson = await ghPerson(world, victim);
        const foreign = github(world).app.installApp(personalAccount(victimPerson));
        const { state } = await startSession(world, fx.lead, fx.team.id);
        const person = await ghPerson(world, fx.lead);
        const own = github(world).app.install(person, personalAccount(person), { state });
        const forged = { ...own.query, installation_id: String(foreign.id) };
        expectSetupRefused(await callback(world, fx.lead, forged), world);
        expect(await grantRows(world, foreign.id)).toHaveLength(0);
        expect(await activeGrantCount(world, fx.team.id)).toBe(0);
      });

      it('SEC-02 (M-3, S6SEC-01): the OAuth step done with another GitHub account than the lead signed in with: account_mismatch, no grant', async () => {
        const fx = await newTeam();
        const friend = await githubUser(world, 'friend-with-an-org');
        const friendPerson = await ghPerson(world, friend);
        const { state } = await startSession(world, fx.lead, fx.team.id);
        // The friend's account owns the installation and authorized the code; the lead only relays it.
        const result = github(world).app.install(friendPerson, personalAccount(friendPerson), {
          state,
        });
        const installationId = Number(result.query.installation_id);
        const response = await callback(world, fx.lead, result.query);
        expect(expectSetupRefused(response, world)).toBe('account_mismatch');
        expect(await grantRows(world, installationId)).toHaveLength(0);
        expect(await activeGrantCount(world, fx.team.id)).toBe(0);
      });

      it("SEC-02 (M-3): the lead's own account passes the same flow", async () => {
        const fx = await newTeam();
        const { installation } = await installApp(world, fx.lead, fx.team.id);
        expect(await grantRows(world, installation.id)).toHaveLength(1);
      });

      it('SEC-02: a code is used once: the same code with a new state is refused', async () => {
        const fx = await newTeam();
        const { installation, query } = await installApp(world, fx.lead, fx.team.id);
        const { state } = await startSession(world, fx.lead, fx.team.id);
        const response = await callback(world, fx.lead, { ...query, state });
        expectSetupRefused(response, world);
        expect(await grantRows(world, installation.id)).toHaveLength(1);
      });

      it('FR-GH-01: an installation without the Actions permission is refused (PERMISSIONS_MISSING screen), no grant', async () => {
        const fx = await newTeam();
        const person = await ghPerson(world, fx.lead);
        const { state } = await startSession(world, fx.lead, fx.team.id);
        const result = github(world).app.install(person, personalAccount(person), {
          state,
          permissions: { metadata: 'read', issues: 'read', pull_requests: 'read' },
        });
        expectSetupRefused(await callback(world, fx.lead, result.query), world);
        expect(await activeGrantCount(world, fx.team.id)).toBe(0);
      });

      it('FR-GH-01: the lead changed between the steps: the old lead completes nothing (NOT_LEAD)', async () => {
        const fx = await newTeam();
        const { state } = await startSession(world, fx.lead, fx.team.id);
        const person = await ghPerson(world, fx.lead);
        const result = github(world).app.install(person, personalAccount(person), { state });
        await world.sql`UPDATE teams.team SET lead_user_id = ${fx.backend.id} WHERE id = ${fx.team.id}`;
        expectSetupRefused(await callback(world, fx.lead, result.query), world);
        expect(await activeGrantCount(world, fx.team.id)).toBe(0);
      });

      it('FR-GH-01: an organization member without the right to install sends a request: no installation_id, no grant, no error page', async () => {
        const fx = await newTeam();
        const person = await ghPerson(world, fx.lead);
        const owner = await githubUser(world, 'org-owner');
        const ownerPerson = await ghPerson(world, owner);
        const org = {
          id: 9_100_000 + (ownerPerson.id % 1000),
          login: `org-${randomUUID().slice(0, 6)}`,
          type: 'Organization' as const,
          ownerIds: [ownerPerson.id],
        };
        const { state } = await startSession(world, fx.lead, fx.team.id);
        const requested = github(world).app.install(person, org, { state });
        expect(requested.query).toMatchObject({ setup_action: 'request' });
        const response = await callback(world, fx.lead, requested.query);
        expect([302, 400, 422], response.body).toContain(response.statusCode);
        expect(await activeGrantCount(world, fx.team.id)).toBe(0);
        // the owner approves later: the approval arrives without state or code and grants nothing
        const approved = github(world).app.approveRequest(ownerPerson, org);
        const late = await callback(world, owner, approved.query);
        expectSetupRefused(late, world);
        expect(await activeGrantCount(world, fx.team.id)).toBe(0);
      });

      it('FR-GH-01: a repeated installation (setup_action=update) by another lead gives that lead a grant of its own on the same installation', async () => {
        const first = await newTeam();
        const second = await newTeam();
        const firstPerson = await ghPerson(world, first.lead);
        const secondPerson = await ghPerson(world, second.lead);
        const org = {
          id: 9_200_000 + (firstPerson.id % 1000),
          login: `shared-${randomUUID().slice(0, 6)}`,
          type: 'Organization' as const,
          ownerIds: [firstPerson.id, secondPerson.id],
        };
        const a = await installApp(world, first.lead, first.team.id, { account: org });
        const b = await installApp(world, second.lead, second.team.id, { account: org });
        expect(a.installation.id).toBe(b.installation.id);
        expect(b.query.setup_action).toBe('update');
        const grants = await grantRows(world, a.installation.id);
        expect(grants.map((g) => g.team_id).sort()).toEqual([first.team.id, second.team.id].sort());
        const [count] = await world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM github.gh_installation WHERE installation_id = ${a.installation.id}`;
        expect(count?.n).toBe(1);
      });

      it('FR-GH-01: state is required by the contract: a callback without it is refused and grants nothing', async () => {
        const fx = await newTeam();
        const person = await ghPerson(world, fx.lead);
        const result = github(world).app.install(person, personalAccount(person), {
          state: 'x',
          dropState: true,
        });
        const response = await world.as(fx.lead).get(setupUrl(result.query));
        expectSetupRefused(response, world);
        expect(await activeGrantCount(world, fx.team.id)).toBe(0);
      });

      it('FR-GH-01: without a session the callback is 401', async () => {
        const response = await world
          .anonymous()
          .get(setupUrl({ installation_id: '1', state: 'x', code: 'y' }));
        expectProblem('githubSetupCallback', response, 401, 'UNAUTHENTICATED');
      });
    });

    describe('listAvailableRepositories (FR-GH-01, SEC-02)', () => {
      const connectedTeam = async (repoCount = 3) => {
        const fx = await newTeam();
        const repos = Array.from({ length: repoCount }, () => repoSpec([]));
        const installed = await installApp(world, fx.lead, fx.team.id, { repos });
        return {
          fx,
          installed,
          names: repos.map((r) => `${installed.installation.account.login}/${r.name}`),
        };
      };

      it('FR-GH-01: lists the repositories of the installation with id, name, visibility, fork flag and date', async () => {
        const { fx, installed, names } = await connectedTeam(3);
        const body = expectOk<AvailableRepositoryListDto>(
          'listAvailableRepositories',
          await availableRepositories(world, fx.lead, fx.team.id, installed.installation.id),
          200,
        );
        expect(body.items.map((r) => r.fullName).sort()).toEqual([...names].sort());
        for (const repo of body.items) {
          expect(repo).toMatchObject({ private: false, fork: false });
          expect(Number.isInteger(repo.repositoryId)).toBe(true);
        }
        expect(body.nextCursor).toBeNull();
      });

      it('FR-GH-01: pages by cursor (limit) and reads the repositories from GitHub with the installation token, not the App JWT', async () => {
        const { fx, installed, names } = await connectedTeam(5);
        const app = github(world).app;
        const first = expectOk<AvailableRepositoryListDto>(
          'listAvailableRepositories',
          await availableRepositories(
            world,
            fx.lead,
            fx.team.id,
            installed.installation.id,
            '&limit=2',
          ),
          200,
        );
        expect(first.items).toHaveLength(2);
        expect(first.nextCursor).toBeTruthy();
        const seen = new Set(first.items.map((r) => r.fullName));
        let cursor = first.nextCursor;
        while (cursor) {
          const page: AvailableRepositoryListDto = expectOk<AvailableRepositoryListDto>(
            'listAvailableRepositories',
            await availableRepositories(
              world,
              fx.lead,
              fx.team.id,
              installed.installation.id,
              `&limit=2&cursor=${encodeURIComponent(cursor)}`,
            ),
            200,
          );
          for (const item of page.items) seen.add(item.fullName);
          cursor = page.nextCursor;
        }
        expect([...seen].sort()).toEqual([...names].sort());
        const reads = app.callsTo(/^\/installation\/repositories$/);
        expect(reads.length).toBeGreaterThanOrEqual(3);
        expect(reads.every((call) => call.auth === 'installation-token')).toBe(true);
        expect(app.callsTo(/\/access_tokens$/).every((call) => call.auth === 'app-jwt')).toBe(true);
      });

      it('FR-GH-01: the list is not cached: a repository added on GitHub shows at once', async () => {
        const { fx, installed } = await connectedTeam(1);
        const added = github(world).app.addRepo(installed.installation.id, {
          name: `late-${randomUUID().slice(0, 6)}`,
        });
        const body = expectOk<AvailableRepositoryListDto>(
          'listAvailableRepositories',
          await availableRepositories(world, fx.lead, fx.team.id, installed.installation.id),
          200,
        );
        expect(body.items.map((r) => r.repositoryId)).toContain(added.id);
      });

      it('FR-GH-01: a private repository is listed as private (the lead sees why it will not pass)', async () => {
        const fx = await newTeam();
        const installed = await installApp(world, fx.lead, fx.team.id, {
          repos: [repoSpec([], { private: true })],
        });
        const body = expectOk<AvailableRepositoryListDto>(
          'listAvailableRepositories',
          await availableRepositories(world, fx.lead, fx.team.id, installed.installation.id),
          200,
        );
        expect(body.items.map((r) => r.private)).toEqual([true]);
      });

      it('SEC-02: an installation without a grant for this team looks absent: 404 INSTALLATION_NOT_GRANTED (no existence oracle)', async () => {
        const mine = await connectedTeam(1);
        const other = await connectedTeam(1);
        const unknown = 99_999_999;
        const foreign = await availableRepositories(
          world,
          mine.fx.lead,
          mine.fx.team.id,
          other.installed.installation.id,
        );
        const missing = await availableRepositories(world, mine.fx.lead, mine.fx.team.id, unknown);
        expectProblem('listAvailableRepositories', foreign, 404, 'INSTALLATION_NOT_GRANTED');
        expectProblem('listAvailableRepositories', missing, 404, 'INSTALLATION_NOT_GRANTED');
        const strip = (r: typeof foreign): unknown => {
          const body = r.json<Record<string, unknown>>();
          delete body.requestId;
          delete body.instance;
          return body;
        };
        expect(strip(foreign)).toEqual(strip(missing));
      });

      it('SEC-02: a grant of the same user for another team does not open this team', async () => {
        const a = await connectedTeam(1);
        const b = await newTeam();
        const response = await availableRepositories(
          world,
          b.lead,
          b.team.id,
          a.installed.installation.id,
        );
        expectProblem('listAvailableRepositories', response, 404, 'INSTALLATION_NOT_GRANTED');
      });

      it('SEC-02: a revoked grant (installation deleted, lead left) no longer opens the list', async () => {
        const { fx, installed } = await connectedTeam(1);
        await world.sql`
          UPDATE github.installation_grant SET revoked_at = now()
           WHERE installation_id = ${installed.installation.id}`;
        const response = await availableRepositories(
          world,
          fx.lead,
          fx.team.id,
          installed.installation.id,
        );
        expectProblem('listAvailableRepositories', response, 404, 'INSTALLATION_NOT_GRANTED');
      });

      it('FR-GH-01: a member who is not the lead gets 403, an outsider 404; missing or bad parameters 400', async () => {
        const { fx, installed } = await connectedTeam(1);
        const stranger = await githubUser(world, 'stranger');
        expectProblem(
          'listAvailableRepositories',
          await availableRepositories(world, fx.backend, fx.team.id, installed.installation.id),
          403,
          'NOT_TEAM_LEAD',
        );
        expectProblem(
          'listAvailableRepositories',
          await availableRepositories(world, stranger, fx.team.id, installed.installation.id),
          404,
          'NOT_FOUND',
        );
        expect(
          (await world.as(fx.lead).get(`/v1/teams/${fx.team.id}/github/available-repositories`))
            .statusCode,
        ).toBe(400);
        const bad = await availableRepositories(
          world,
          fx.lead,
          fx.team.id,
          installed.installation.id,
          '&cursor=not-a-cursor',
        );
        expect(bad.statusCode).toBe(400);
      });

      it('SEC-02: a cursor made for another installation or team is refused (it is signed and bound)', async () => {
        const a = await connectedTeam(4);
        const b = await connectedTeam(4);
        const page = expectOk<AvailableRepositoryListDto>(
          'listAvailableRepositories',
          await availableRepositories(
            world,
            a.fx.lead,
            a.fx.team.id,
            a.installed.installation.id,
            '&limit=1',
          ),
          200,
        );
        const cursor = page.nextCursor ?? '';
        expect(cursor).not.toBe('');
        const reused = await availableRepositories(
          world,
          b.fx.lead,
          b.fx.team.id,
          b.installed.installation.id,
          `&limit=1&cursor=${encodeURIComponent(cursor)}`,
        );
        expect(reused.statusCode).toBe(400);
      });

      it('FR-GH-01: after the installation is deleted on GitHub the list answers 404 and does not return stale repositories', async () => {
        const { fx, installed } = await connectedTeam(2);
        github(world).app.uninstall(installed.installation.id);
        const response = await availableRepositories(
          world,
          fx.lead,
          fx.team.id,
          installed.installation.id,
        );
        expect([404, 409, 422, 503]).toContain(response.statusCode);
        expect(response.statusCode === 200).toBe(false);
      });
    });
  },
);
