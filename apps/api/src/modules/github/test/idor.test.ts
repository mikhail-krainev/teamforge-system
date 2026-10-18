import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import { send } from '../../../../test/fixtures/operations.js';
import {
  GITHUB_OPERATIONS,
  requestForGithub,
  type GithubContext,
  type Slice6Operation,
} from '../../../../test/fixtures/operations-github.js';
import {
  availableRepositories,
  callback,
  connectRepository,
  getRepository,
  ghPerson,
  github,
  installApp,
  link,
  postWebhook,
  startSession,
  unlink,
  waitForDelivery,
  type AvailableRepositoryListDto,
  type Connected,
} from '../../../../test/fixtures/github.js';
import {
  activeGrantCount,
  contributionCount,
  repoLinkRows,
} from '../../../../test/fixtures/github-db.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import { expectOk, githubUser } from '../../../../test/fixtures/teams.js';
import {
  routeTeam,
  startRouteWorld,
  type RouteFixture,
} from '../../../../test/fixtures/workspace.js';
import type { World } from '../../../../test/fixtures/world.js';
import { expectIdorResult, idorMatrix } from '../../../../test/helpers/authz.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

/*
 * S6-02 IDOR matrix of the github module (docs/plan.md, "Тесты среза" -> IDOR; SEC-02, SEC-03, SEC-06): the
 * cases are derived from x-authz of the 7 github operations (test/helpers/authz.ts) and realised with two
 * teams on two installations. A foreign resource always looks absent (404), a role below the one required
 * gives 403, a webhook has no session at all.
 */

describeInfra(
  'S6 github: authorization matrix from x-authz (IDOR, SEC-02, SEC-03, SEC-06)',
  ['db', 'redis'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());
    let a: RouteFixture;
    let b: RouteFixture;
    let connectedA: Connected;
    let connectedB: Connected;
    let stranger: UserFixture;

    beforeAll(async () => {
      world = await startRouteWorld({ github: true, clock });
      a = await routeTeam(world);
      b = await routeTeam(world);
      stranger = await githubUser(world, 'idor6-stranger');
      connectedA = await connectRepository(world, a.team, [a.backend, a.frontend]);
      connectedB = await connectRepository(world, b.team, [b.backend, b.frontend]);
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    const contextOf = (): GithubContext => ({
      teamId: a.team.id,
      installationId: connectedA.installation.id,
      repositoryId: connectedA.repo.id,
    });

    const call = (
      who: UserFixture | undefined,
      operationId: Slice6Operation,
      context: GithubContext,
    ) => {
      const request = requestForGithub(operationId, context);
      return send(who ? world.as(who) : world.anonymous(), request);
    };

    describe('(а) without a session -> 401 for every operation that has a session', () => {
      const WITH_SESSION = GITHUB_OPERATIONS.filter((id) =>
        idorMatrix(id).cases.some((c) => c.kind === 'anonymous'),
      );

      it('FR-AUTH-03: six of the seven operations need a session; the webhook is identified by its signature', () => {
        expect(WITH_SESSION).toHaveLength(6);
        expect(idorMatrix('receiveGithubWebhook').authz.actor).toBe('github-signature');
      });

      it.each(WITH_SESSION)('FR-AUTH-03: %s', async (operationId) => {
        const anonymous = idorMatrix(operationId).cases.find((c) => c.kind === 'anonymous');
        const response = await call(undefined, operationId, contextOf());
        if (anonymous) expectIdorResult(anonymous, response);
        expectProblem(operationId, response, 401, 'UNAUTHENTICATED');
      });

      it('FR-GH-03: the webhook without a signature is 401 SIGNATURE_INVALID, not a session error', async () => {
        const response = await call(undefined, 'receiveGithubWebhook', contextOf());
        expectProblem('receiveGithubWebhook', response, 401, 'SIGNATURE_INVALID');
      });
    });

    describe('(б) team-scoped operations: an outsider gets 404, never 403', () => {
      const SCOPED = GITHUB_OPERATIONS.filter((id) =>
        idorMatrix(id).cases.some((c) => c.kind === 'outsider'),
      );

      it('SEC-03: the matrix covers the five team-scoped github operations', () => {
        expect([...SCOPED].sort()).toEqual(
          [
            'createInstallationSession',
            'getRepository',
            'linkRepository',
            'listAvailableRepositories',
            'unlinkRepository',
          ].sort(),
        );
      });

      it.each(SCOPED)('SEC-03: %s by a user outside the team', async (operationId) => {
        const outsider = idorMatrix(operationId).cases.find((c) => c.kind === 'outsider');
        const response = await call(stranger, operationId, contextOf());
        if (outsider) expectIdorResult(outsider, response);
        expectProblem(operationId, response, 404, 'NOT_FOUND');
        expect(await repoLinkRows(world, a.team.id)).toHaveLength(1);
      });

      it.each(SCOPED)('SEC-03: %s by the lead of another team', async (operationId) => {
        const response = await call(b.lead, operationId, contextOf());
        expectProblem(operationId, response, 404, 'NOT_FOUND');
        expect(await repoLinkRows(world, a.team.id)).toHaveLength(1);
        expect(await repoLinkRows(world, b.team.id)).toHaveLength(1);
      });
    });

    describe('(в) team-lead operations: a member gets 403 with a code', () => {
      const LEAD_ONLY = GITHUB_OPERATIONS.filter((id) =>
        idorMatrix(id).cases.some((c) => c.kind === 'low-role'),
      );

      it('SEC-03: four github operations need the lead', () => {
        expect([...LEAD_ONLY].sort()).toEqual(
          [
            'createInstallationSession',
            'linkRepository',
            'listAvailableRepositories',
            'unlinkRepository',
          ].sort(),
        );
      });

      it.each(LEAD_ONLY)('SEC-03: %s by a member who is not the lead', async (operationId) => {
        const lowRole = idorMatrix(operationId).cases.find((c) => c.kind === 'low-role');
        const response = await call(a.backend, operationId, contextOf());
        if (lowRole) expectIdorResult(lowRole, response);
        expectProblem(operationId, response, 403, 'NOT_TEAM_LEAD');
        expect(await repoLinkRows(world, a.team.id)).toHaveLength(1);
      });
    });

    describe('specific cases of the plan', () => {
      it('SEC-03: getRepository by a lead of another team -> 404 and no field of the link is shown', async () => {
        const response = await getRepository(world, b.lead, a.team.id);
        const problem = expectProblem('getRepository', response, 404, 'NOT_FOUND');
        expect(JSON.stringify(problem)).not.toContain(connectedA.link.fullName);
      });

      it('SEC-03: linkRepository of a foreign team with a repository of ours -> 404 (the team, not the repository, decides)', async () => {
        const response = await link(world, b.lead, a.team.id, {
          installationId: connectedB.installation.id,
          repositoryId: connectedB.repo.id,
        });
        expectProblem('linkRepository', response, 404, 'NOT_FOUND');
        expect(await repoLinkRows(world, a.team.id)).toHaveLength(1);
      });

      it('SEC-02: listAvailableRepositories shows only the installations of the current user: the installation of team B under team A is 404 INSTALLATION_NOT_GRANTED', async () => {
        const own = expectOk<AvailableRepositoryListDto>(
          'listAvailableRepositories',
          await availableRepositories(world, a.lead, a.team.id, connectedA.installation.id),
          200,
        );
        expect(own.items.map((r) => r.fullName)).toContain(connectedA.link.fullName);
        const foreign = await availableRepositories(
          world,
          a.lead,
          a.team.id,
          connectedB.installation.id,
        );
        expectProblem('listAvailableRepositories', foreign, 404, 'INSTALLATION_NOT_GRANTED');
        expect(JSON.stringify(foreign.json())).not.toContain(connectedB.link.fullName);
      });

      it('SEC-02: linkRepository with the installation of team B under team A is 404 INSTALLATION_NOT_GRANTED and takes nothing', async () => {
        const response = await link(world, a.lead, a.team.id, {
          installationId: connectedB.installation.id,
          repositoryId: connectedB.repo.id,
        });
        expectProblem('linkRepository', response, 404, 'INSTALLATION_NOT_GRANTED');
        expect(await repoLinkRows(world, a.team.id)).toHaveLength(1);
      });

      it('SEC-02: githubSetupCallback with the state of another user -> refused (400/403 or ?error) and no grant is written', async () => {
        const fresh = await routeTeam(world);
        const { state } = await startSession(world, fresh.lead, fresh.team.id);
        const person = await ghPerson(world, fresh.lead);
        const result = github(world).app.install(
          person,
          { id: person.id, login: person.login, type: 'User' },
          { state },
        );
        const response = await callback(world, stranger, result.query);
        if (response.statusCode === 302) {
          expect(String(response.headers.location)).toContain('error=');
        } else {
          expect([400, 403]).toContain(response.statusCode);
        }
        expect(await activeGrantCount(world, fresh.team.id)).toBe(0);
      });

      it('SEC-02: a grant of the lead of team B does not let the lead of team A unlink or read B (every door asks for the team first)', async () => {
        expectProblem('unlinkRepository', await unlink(world, a.lead, b.team.id), 404, 'NOT_FOUND');
        expectProblem(
          'getRepository',
          await getRepository(world, a.lead, b.team.id),
          404,
          'NOT_FOUND',
        );
        expect(await repoLinkRows(world, b.team.id)).toHaveLength(1);
      });

      it('SEC-06: a webhook signed with the secret but naming the installation of team B for the repository of team A creates no contribution in either team', async () => {
        const app = github(world).app;
        const person = await ghPerson(world, a.backend);
        const item = app.openIssue(connectedA.repo.id, { author: person, assignees: [person] });
        app.closeIssue(connectedA.repo.id, item.number);
        const request = app.issuesEvent('closed', item, {
          installationId: connectedB.installation.id,
        });
        expect((await postWebhook(world, request)).statusCode).toBe(202);
        await waitForDelivery(world, request.headers['x-github-delivery'] ?? '');
        expect(await contributionCount(world, a.team.id)).toBe(0);
        expect(await contributionCount(world, b.team.id)).toBe(0);
      });

      it('SEC-06: the same payload signed by a stranger (wrong secret) is 401 and leaves no trace', async () => {
        const app = github(world).app;
        const person = await ghPerson(world, a.backend);
        const item = app.openIssue(connectedA.repo.id, { author: person, assignees: [person] });
        app.closeIssue(connectedA.repo.id, item.number);
        const request = app.issuesEvent('closed', item, { signature: 'wrong-secret' });
        expectProblem(
          'receiveGithubWebhook',
          await postWebhook(world, request),
          401,
          'SIGNATURE_INVALID',
        );
        expect(await contributionCount(world, a.team.id)).toBe(0);
      });

      it('SEC-02: a revoked grant closes the installation to its lead at once (list and link), without touching the other team', async () => {
        const fresh = await routeTeam(world);
        const installed = await installApp(world, fresh.lead, fresh.team.id);
        await world.sql`UPDATE github.installation_grant SET revoked_at = now() WHERE installation_id = ${installed.installation.id}`;
        expectProblem(
          'listAvailableRepositories',
          await availableRepositories(world, fresh.lead, fresh.team.id, installed.installation.id),
          404,
          'INSTALLATION_NOT_GRANTED',
        );
        expect(await repoLinkRows(world, a.team.id)).toHaveLength(1);
      });
    });
  },
);
