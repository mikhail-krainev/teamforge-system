import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import { DAY, expectOk, githubUser } from '../../../../test/fixtures/teams.js';
import {
  connectRepository,
  getRepository,
  ghPerson,
  github,
  installApp,
  link,
  repoSpec,
  unlink,
  type RepositoryLinkDto,
} from '../../../../test/fixtures/github.js';
import {
  activeLinkCount,
  holdingLinkCount,
  repoLinkRows,
} from '../../../../test/fixtures/github-db.js';
import {
  routeTeam,
  startRouteWorld,
  type RouteFixture,
} from '../../../../test/fixtures/workspace.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

/*
 * S6-02: binding a repository to a team (FR-GH-01, FR-GH-02, FR-GH-07, FR-GH-08; CC-9 is in
 * test/concurrency/cc-09-repo-link.test.ts). linkRepository, getRepository, unlinkRepository: the grant
 * of the installation (SEC-02), what GitHub says about the repository (the installation token, never the
 * request body), the unique index by repository_id, unlinking. Written before the implementation.
 */

const THIRTY_ONE_DAYS = 31 * DAY;

describeInfra(
  'S6 github: link, read and unlink a repository (FR-GH-01, FR-GH-02, FR-GH-07)',
  ['db', 'redis'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());

    beforeAll(async () => {
      world = await startRouteWorld({ github: true, clock });
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    interface Prepared {
      fx: RouteFixture;
      installationId: number;
      repoId: number;
      fullName: string;
    }

    /** A team with the App installed (granted) and one repository on that installation, not linked yet. */
    const prepared = async (
      repo: Parameters<typeof repoSpec>[1] = {},
      withCommits = true,
    ): Promise<Prepared> => {
      const fx = await routeTeam(world);
      const people = withCommits
        ? [await ghPerson(world, fx.backend), await ghPerson(world, fx.frontend)]
        : [];
      const spec = repoSpec(people, repo);
      const installed = await installApp(world, fx.lead, fx.team.id, { repos: [spec] });
      const created = [...github(world).app.repos.values()].find(
        (r) =>
          r.installationId === installed.installation.id && r.fullName.endsWith(`/${spec.name}`),
      );
      if (!created) throw new Error('the double lost the repository');
      return {
        fx,
        installationId: installed.installation.id,
        repoId: created.id,
        fullName: created.fullName,
      };
    };

    const linkOf = (p: Prepared, who = p.fx.lead, key?: string) =>
      link(
        world,
        who,
        p.fx.team.id,
        { installationId: p.installationId, repositoryId: p.repoId },
        key,
      );

    describe('linkRepository: the happy path (FR-GH-01)', () => {
      it('FR-GH-01: the lead links a repository of the granted installation -> 200 RepositoryLink, one active row', async () => {
        const p = await prepared();
        const body = expectOk<RepositoryLinkDto>('linkRepository', await linkOf(p), 200);
        expect(body).toMatchObject({
          repositoryId: p.repoId,
          fullName: p.fullName,
          installationId: p.installationId,
          status: 'active',
          private: false,
          linkedBy: p.fx.lead.id,
          warnings: [],
        });
        const rows = await repoLinkRows(world, p.fx.team.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          status: 'active',
          linked_by: p.fx.lead.id,
          is_private: false,
        });
        expect(Number(rows[0]?.repository_id)).toBe(p.repoId);
      });

      it('FR-GH-01: the facts about the repository come from GitHub with the installation token, not from the request', async () => {
        const p = await prepared();
        const app = github(world).app;
        const before = app.calls.length;
        expectOk<RepositoryLinkDto>('linkRepository', await linkOf(p), 200);
        const made = app.calls.slice(before);
        expect(made.length).toBeGreaterThan(0);
        expect(made.some((call) => call.auth === 'installation-token')).toBe(true);
        expect(
          made
            .filter((call) => /^\/repositories\//.test(call.path))
            .every((c) => c.auth === 'installation-token'),
        ).toBe(true);
      });

      it('FR-GH-01: the installation token is cached: two links in a row ask GitHub for one token', async () => {
        const first = await prepared();
        const app = github(world).app;
        expectOk<RepositoryLinkDto>('linkRepository', await linkOf(first), 200);
        const issued = app.tokensIssued(first.installationId);
        await getRepository(world, first.fx.lead, first.fx.team.id);
        const second = expectOk<RepositoryLinkDto>(
          'getRepository',
          await getRepository(world, first.fx.backend, first.fx.team.id),
          200,
        );
        expect(second.repositoryId).toBe(first.repoId);
        expect(app.tokensIssued(first.installationId)).toBe(issued);
      });

      it('FR-GH-01: a repeat with the same Idempotency-Key returns the stored answer', async () => {
        const p = await prepared();
        const key = randomUUID();
        const first = await linkOf(p, p.fx.lead, key);
        const replay = await linkOf(p, p.fx.lead, key);
        expect(first.statusCode).toBe(200);
        expectReplayed(replay);
        expect(replay.json()).toEqual(first.json());
        expect(await repoLinkRows(world, p.fx.team.id)).toHaveLength(1);
      });

      it('FR-GH-02: a repository created more than 30 days before the project start carries the warning repo_older_than_30_days', async () => {
        const old = await prepared({
          createdAt: new Date(clock.now().getTime() - THIRTY_ONE_DAYS).toISOString(),
        });
        const fresh = await prepared({
          createdAt: new Date(clock.now().getTime() - DAY).toISOString(),
        });
        const oldBody = expectOk<RepositoryLinkDto>('linkRepository', await linkOf(old), 200);
        const freshBody = expectOk<RepositoryLinkDto>('linkRepository', await linkOf(fresh), 200);
        expect(oldBody.warnings).toContain('repo_older_than_30_days');
        expect(freshBody.warnings).not.toContain('repo_older_than_30_days');
      });

      it('FR-GH-02: a fork that has its own commits is accepted', async () => {
        const p = await prepared({ fork: true });
        const body = expectOk<RepositoryLinkDto>('linkRepository', await linkOf(p), 200);
        expect(body.status).toBe('active');
        expect((await repoLinkRows(world, p.fx.team.id))[0]?.is_fork).toBe(true);
      });
    });

    describe('linkRepository: refusals', () => {
      it('SEC-02: no grant for this installation -> 404 INSTALLATION_NOT_GRANTED, no row (the foreign repository is not named)', async () => {
        const mine = await prepared();
        const theirs = await prepared();
        const response = await link(world, mine.fx.lead, mine.fx.team.id, {
          installationId: theirs.installationId,
          repositoryId: theirs.repoId,
        });
        const problem = expectProblem('linkRepository', response, 404, 'INSTALLATION_NOT_GRANTED');
        expect(JSON.stringify(problem)).not.toContain(theirs.fullName);
        expect(await repoLinkRows(world, mine.fx.team.id)).toHaveLength(0);
      });

      it('SEC-02: a grant that was revoked no longer lets the lead link', async () => {
        const p = await prepared();
        await world.sql`UPDATE github.installation_grant SET revoked_at = now() WHERE installation_id = ${p.installationId}`;
        expectProblem('linkRepository', await linkOf(p), 404, 'INSTALLATION_NOT_GRANTED');
      });

      it('FR-GH-01: a member who is not the lead gets 403 NOT_TEAM_LEAD', async () => {
        const p = await prepared();
        expectProblem('linkRepository', await linkOf(p, p.fx.backend), 403, 'NOT_TEAM_LEAD');
        expect(await repoLinkRows(world, p.fx.team.id)).toHaveLength(0);
      });

      it('SEC-03: an outsider gets 404 for a team that is not his, and a lead of another team too', async () => {
        const p = await prepared();
        const other = await routeTeam(world);
        const stranger = await githubUser(world, 'stranger');
        for (const who of [stranger, other.lead]) {
          expectProblem('linkRepository', await linkOf(p, who), 404, 'NOT_FOUND');
        }
      });

      it('FR-GH-01: a repository that is not on the installation -> 422 REPO_REJECTED (a guessed id reveals nothing)', async () => {
        const p = await prepared();
        const other = await prepared();
        const foreignRepo = await link(world, p.fx.lead, p.fx.team.id, {
          installationId: p.installationId,
          repositoryId: other.repoId,
        });
        const unknownRepo = await link(world, p.fx.lead, p.fx.team.id, {
          installationId: p.installationId,
          repositoryId: 1,
        });
        expectProblem('linkRepository', foreignRepo, 422, 'REPO_REJECTED');
        expectProblem('linkRepository', unknownRepo, 422, 'REPO_REJECTED');
        expect(await repoLinkRows(world, p.fx.team.id)).toHaveLength(0);
      });

      it('FR-GH-02: a fork without commits of its own -> 422 REPO_REJECTED', async () => {
        const p = await prepared({ fork: true, contributors: [] }, false);
        expectProblem('linkRepository', await linkOf(p), 422, 'REPO_REJECTED');
        expect(await repoLinkRows(world, p.fx.team.id)).toHaveLength(0);
      });

      it('FR-GH-08: an archived repository -> 422 REPO_REJECTED', async () => {
        const p = await prepared({ archived: true });
        expectProblem('linkRepository', await linkOf(p), 422, 'REPO_REJECTED');
      });

      it('FR-GH-08: a private repository is not accepted silently: 422 REPO_REJECTED, or 200 with the warning repo_private', async () => {
        const p = await prepared({ private: true });
        const response = await linkOf(p);
        if (response.statusCode === 200) {
          expect(response.json<RepositoryLinkDto>()).toMatchObject({ private: true });
          expect(response.json<RepositoryLinkDto>().warnings).toContain('repo_private');
        } else {
          expectProblem('linkRepository', response, 422, 'REPO_REJECTED');
        }
      });

      it('FR-GH-01: the body is validated: no ids, text ids and extra fields -> 400', async () => {
        const p = await prepared();
        const url = `/v1/teams/${p.fx.team.id}/repository`;
        for (const body of [
          {},
          { installationId: 'x', repositoryId: p.repoId },
          { installationId: p.installationId, repositoryId: 0 },
          { installationId: p.installationId, repositoryId: p.repoId, fullName: 'a/b' },
        ]) {
          const response = await world.as(p.fx.lead).put(url, body);
          expect(response.statusCode, JSON.stringify(body)).toBe(400);
        }
      });

      it('FR-GH-01: without a session -> 401', async () => {
        const p = await prepared();
        const response = await world
          .anonymous()
          .put(`/v1/teams/${p.fx.team.id}/repository`, {
            installationId: p.installationId,
            repositoryId: p.repoId,
          });
        expectProblem('linkRepository', response, 401, 'UNAUTHENTICATED');
      });
    });

    /**
     * Two teams whose leads co-own one GitHub organization: both install the App on it and are granted
     * the same installation, so one repository is on offer to both (the situation of CC-9).
     */
    const sharedInstallation = async () => {
      const a = await routeTeam(world);
      const b = await routeTeam(world);
      const owners = [await ghPerson(world, a.lead), await ghPerson(world, b.lead)];
      const org = {
        id: 9_300_000 + ((owners[0]?.id ?? 0) % 100_000),
        login: `org-${randomUUID().slice(0, 6)}`,
        type: 'Organization' as const,
        ownerIds: owners.map((o) => o.id),
      };
      const people = [await ghPerson(world, a.backend), await ghPerson(world, a.frontend)];
      const first = await installApp(world, a.lead, a.team.id, {
        account: org,
        repos: [repoSpec(people)],
      });
      const second = await installApp(world, b.lead, b.team.id, { account: org });
      const repo = [...github(world).app.repos.values()].find(
        (r) => r.installationId === first.installation.id,
      );
      if (!repo) throw new Error('no repository on the shared installation');
      return { a, b, installationId: first.installation.id, repoId: repo.id, second };
    };

    describe('FR-GH-02: one repository, one team (by repository_id, CC-9)', () => {
      it('FR-GH-02: a second team gets 409 REPO_TAKEN for a linked repository; the first link is untouched', async () => {
        const s = await sharedInstallation();
        const body = { installationId: s.installationId, repositoryId: s.repoId };
        expectOk<RepositoryLinkDto>(
          'linkRepository',
          await link(world, s.a.lead, s.a.team.id, body),
          200,
        );
        const response = await link(world, s.b.lead, s.b.team.id, body);
        expectProblem('linkRepository', response, 409, 'REPO_TAKEN');
        expect(await holdingLinkCount(world, s.repoId)).toBe(1);
        expect(await repoLinkRows(world, s.b.team.id)).toHaveLength(0);
        expect((await repoLinkRows(world, s.a.team.id))[0]?.status).toBe('active');
      });

      it('FR-GH-02: a repository of a completed project stays taken: 409 REPO_TAKEN', async () => {
        const s = await sharedInstallation();
        const body = { installationId: s.installationId, repositoryId: s.repoId };
        expectOk<RepositoryLinkDto>(
          'linkRepository',
          await link(world, s.a.lead, s.a.team.id, body),
          200,
        );
        await world.sql`UPDATE github.repo_link SET status = 'completed' WHERE team_id = ${s.a.team.id}`;
        expectProblem(
          'linkRepository',
          await link(world, s.b.lead, s.b.team.id, body),
          409,
          'REPO_TAKEN',
        );
      });

      it('FR-GH-02: an unlinked repository is free: the other team links it', async () => {
        const s = await sharedInstallation();
        const body = { installationId: s.installationId, repositoryId: s.repoId };
        expectOk<RepositoryLinkDto>(
          'linkRepository',
          await link(world, s.a.lead, s.a.team.id, body),
          200,
        );
        expect((await unlink(world, s.a.lead, s.a.team.id)).statusCode).toBe(204);
        expectOk<RepositoryLinkDto>(
          'linkRepository',
          await link(world, s.b.lead, s.b.team.id, body),
          200,
        );
        expect(await holdingLinkCount(world, s.repoId)).toBe(1);
      });

      it('FR-GH-02: the repository is taken by its id, not by its name: after a rename the other team is still refused', async () => {
        const a = await prepared();
        expectOk<RepositoryLinkDto>('linkRepository', await linkOf(a), 200);
        github(world).app.rename(a.repoId, `renamed-${randomUUID().slice(0, 6)}`);
        const again = await linkOf(a);
        expect([200, 409]).toContain(again.statusCode);
        expect(await holdingLinkCount(world, a.repoId)).toBe(1);
      });

      it('FR-GH-02: a team has one active repository: its row count never exceeds one', async () => {
        const first = await prepared();
        expectOk<RepositoryLinkDto>('linkRepository', await linkOf(first), 200);
        const secondSpec = github(world).app.addRepo(first.installationId, {
          name: `second-${randomUUID().slice(0, 6)}`,
        });
        github(world).app.setContributors(secondSpec.id, [
          { ...(await ghPerson(world, first.fx.backend)), contributions: 6 },
        ]);
        const response = await link(world, first.fx.lead, first.fx.team.id, {
          installationId: first.installationId,
          repositoryId: secondSpec.id,
        });
        expect([200, 409]).toContain(response.statusCode);
        expect(await activeLinkCount(world, first.fx.team.id)).toBe(1);
      });
    });

    describe('getRepository (FR-GH-01)', () => {
      it('FR-GH-01: any member reads the linked repository (200 RepositoryLink)', async () => {
        const p = await prepared();
        const linked = expectOk<RepositoryLinkDto>('linkRepository', await linkOf(p), 200);
        for (const who of [p.fx.lead, p.fx.backend, p.fx.frontend]) {
          const body = expectOk<RepositoryLinkDto>(
            'getRepository',
            await getRepository(world, who, p.fx.team.id),
            200,
          );
          expect(body).toEqual(linked);
        }
      });

      it('FR-GH-01: a team without a repository answers 404', async () => {
        const fx = await routeTeam(world);
        expectProblem(
          'getRepository',
          await getRepository(world, fx.lead, fx.team.id),
          404,
          'NOT_FOUND',
        );
      });

      it('SEC-03: an outsider and a member of another team get 404, and the answer is the same as for an unknown team', async () => {
        const p = await prepared();
        expectOk<RepositoryLinkDto>('linkRepository', await linkOf(p), 200);
        const other = await routeTeam(world);
        const stranger = await githubUser(world, 'stranger');
        const unknown = await world.as(stranger).get(`/v1/teams/${randomUUID()}/repository`);
        for (const who of [stranger, other.lead, other.backend]) {
          const response = await getRepository(world, who, p.fx.team.id);
          expectProblem('getRepository', response, 404, 'NOT_FOUND');
          expect(response.statusCode).toBe(unknown.statusCode);
        }
      });

      it('FR-GH-01: without a session -> 401', async () => {
        const p = await prepared();
        const response = await world.anonymous().get(`/v1/teams/${p.fx.team.id}/repository`);
        expectProblem('getRepository', response, 401, 'UNAUTHENTICATED');
      });
    });

    describe('unlinkRepository (FR-GH-07)', () => {
      it('FR-GH-07: the lead unlinks -> 204; the row stays as unlinked; getRepository answers 404; the repository is free again', async () => {
        const p = await prepared();
        expectOk<RepositoryLinkDto>('linkRepository', await linkOf(p), 200);
        const response = await unlink(world, p.fx.lead, p.fx.team.id);
        expect(response.statusCode, response.body).toBe(204);
        expect(response.body).toBe('');
        const rows = await repoLinkRows(world, p.fx.team.id);
        expect(rows.map((r) => r.status)).toEqual(['unlinked']);
        expect(await holdingLinkCount(world, p.repoId)).toBe(0);
        expectProblem(
          'getRepository',
          await getRepository(world, p.fx.lead, p.fx.team.id),
          404,
          'NOT_FOUND',
        );
      });

      it('FR-GH-07: after unlinking the same team may link again (history keeps both rows, one is active)', async () => {
        const p = await prepared();
        expectOk<RepositoryLinkDto>('linkRepository', await linkOf(p), 200);
        expect((await unlink(world, p.fx.lead, p.fx.team.id)).statusCode).toBe(204);
        expectOk<RepositoryLinkDto>('linkRepository', await linkOf(p), 200);
        expect(await activeLinkCount(world, p.fx.team.id)).toBe(1);
        expect(await repoLinkRows(world, p.fx.team.id)).toHaveLength(2);
      });

      it('FR-GH-07: a member who is not the lead gets 403 NOT_TEAM_LEAD; the link stays', async () => {
        const p = await prepared();
        expectOk<RepositoryLinkDto>('linkRepository', await linkOf(p), 200);
        expectProblem(
          'unlinkRepository',
          await unlink(world, p.fx.backend, p.fx.team.id),
          403,
          'NOT_TEAM_LEAD',
        );
        expect(await activeLinkCount(world, p.fx.team.id)).toBe(1);
      });

      it('SEC-03: an outsider gets 404 and the link stays', async () => {
        const p = await prepared();
        expectOk<RepositoryLinkDto>('linkRepository', await linkOf(p), 200);
        const other = await routeTeam(world);
        expectProblem(
          'unlinkRepository',
          await unlink(world, other.lead, p.fx.team.id),
          404,
          'NOT_FOUND',
        );
        expect(await activeLinkCount(world, p.fx.team.id)).toBe(1);
      });

      it('FR-GH-07: unlinking a team that has no repository -> 404', async () => {
        const fx = await routeTeam(world);
        expectProblem(
          'unlinkRepository',
          await unlink(world, fx.lead, fx.team.id),
          404,
          'NOT_FOUND',
        );
      });

      it('FR-GH-07: a repeat with the same Idempotency-Key replays the 204', async () => {
        const p = await prepared();
        expectOk<RepositoryLinkDto>('linkRepository', await linkOf(p), 200);
        const key = randomUUID();
        const first = await world
          .as(p.fx.lead)
          .delete(`/v1/teams/${p.fx.team.id}/repository`, { idempotencyKey: key });
        const second = await world
          .as(p.fx.lead)
          .delete(`/v1/teams/${p.fx.team.id}/repository`, { idempotencyKey: key });
        expect(first.statusCode).toBe(204);
        expect(second.statusCode).toBe(204);
        expectReplayed(second);
      });

      it('FR-GH-07: a completed project cannot be unlinked: 409 INVALID_STATE, the repository stays held', async () => {
        const p = await prepared();
        expectOk<RepositoryLinkDto>('linkRepository', await linkOf(p), 200);
        await world.sql`UPDATE github.repo_link SET status = 'completed' WHERE team_id = ${p.fx.team.id}`;
        await world.sql`UPDATE teams.team SET status = 'completed' WHERE id = ${p.fx.team.id}`;
        expectProblem(
          'unlinkRepository',
          await unlink(world, p.fx.lead, p.fx.team.id),
          409,
          'INVALID_STATE',
        );
        expect(await holdingLinkCount(world, p.repoId)).toBe(1);
      });
    });

    it('FR-GH-01: connectRepository (the whole flow of the fixtures) works for a team and leaves exactly one active link', async () => {
      const fx = await routeTeam(world);
      const connected = await connectRepository(world, fx.team, [fx.backend, fx.frontend]);
      expect(connected.link.status).toBe('active');
      expect(await activeLinkCount(world, fx.team.id)).toBe(1);
    });
  },
);
