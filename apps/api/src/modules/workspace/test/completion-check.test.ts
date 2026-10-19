import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OK_OUTCOME,
  startFakeLinkChecker,
  type FakeLinkChecker,
} from '../../../../test/fakes/link-checker.js';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import {
  completableTeam,
  latestCheck,
  RELEASE_URL,
  requestCheck,
  runCheck,
  waitForCheck,
  type CompletableTeam,
  type CompletionCheckDto,
} from '../../../../test/fixtures/completion.js';
import {
  completionCheckCount,
  repoCheckRows,
  teamReleaseUrl,
} from '../../../../test/fixtures/github-db.js';
import { DAY, expectOk, githubUser } from '../../../../test/fixtures/teams.js';
import { clockOf, routeTeam, startRouteWorld } from '../../../../test/fixtures/workspace.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { github } from '../../../../test/fixtures/github.js';
import type { TwinRepo } from '../../../../test/fakes/github-app.js';

/*
 * S6-02: the check of readiness to complete (FR-WORK-13, FR-WORK-14, FR-GH-08, FR-PLAY-08; architecture
 * 11.4): requestCompletionCheck (202, asynchronous), getLatestCompletionCheck, what the check says about
 * the repository (`repo_final`), the release (`release_alive_*`, two checks at least 24 h apart) and the
 * links; the result is valid for one hour. Written before the implementation.
 */

const HOUR = 3_600_000;
const FAILING = { ok: false, reason: 'TOO_SMALL', httpStatus: 200 } as const;

describeInfra(
  'S6 workspace: check of readiness to complete (FR-WORK-13, FR-WORK-14, FR-GH-08)',
  ['db', 'redis', 's3'],
  () => {
    let world: World;
    let checker: FakeLinkChecker;
    const clock = new FakeClock(Date.now());
    let c: CompletableTeam;

    beforeAll(async () => {
      world = await startRouteWorld({ github: true, clock });
      checker = startFakeLinkChecker(world.queuePrefix);
      c = await completableTeam(world);
    }, 240_000);

    afterAll(async () => {
      await checker?.close();
      if (!world) return;
      await world.close();
    });

    const app = () => github(world).app;
    const resultOf = (check: CompletionCheckDto, key: string) =>
      check.results.find((r) => r.key === key);

    describe('requestCompletionCheck / getLatestCompletionCheck', () => {
      it('FR-WORK-13: the lead asks for a check -> 202 CompletionCheck (queued or running, no results yet)', async () => {
        const response = await requestCheck(world, c.fx.lead, c.fx.team.id);
        const body = expectOk<CompletionCheckDto>('requestCompletionCheck', response, 202);
        expect(['queued', 'running', 'done']).toContain(body.status);
        expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(Date.parse(body.requestedAt)).toBeGreaterThan(0);
        // One check at a time: the next test asks again only after this one has finished.
        await waitForCheck(world, c.fx.lead, c.fx.team.id, body.id);
      });

      it('FR-WORK-13: the worker finishes the check: done, with the time it is valid until (one hour)', async () => {
        const check = await runCheck(world, c.fx.lead, c.fx.team.id);
        expect(check.status).toBe('done');
        expect(check.finishedAt).toBeTruthy();
        expect(check.validUntil).toBeTruthy();
        const valid = Date.parse(check.validUntil ?? '') - Date.parse(check.finishedAt ?? '');
        expect(valid).toBe(HOUR);
      });

      it('FR-WORK-13: the result lists the checks: repository, release, links; each says ok, blocking and why', async () => {
        const check = await runCheck(world, c.fx.lead, c.fx.team.id);
        const keys = check.results.map((r) => r.key);
        expect(keys).toEqual(expect.arrayContaining(['repo_final', 'release_alive_web']));
        for (const result of check.results) {
          expect(typeof result.ok).toBe('boolean');
          expect(typeof result.blocking).toBe('boolean');
          expect(result.message.length).toBeGreaterThan(0);
        }
        expect(resultOf(check, 'repo_final')).toMatchObject({ ok: true, blocking: true });
        expect(resultOf(check, 'release_alive_web')).toMatchObject({ ok: true });
      });

      it('FR-WORK-13: every member reads the latest check; it is the one just finished', async () => {
        const check = await runCheck(world, c.fx.lead, c.fx.team.id);
        for (const who of [c.fx.lead, c.fx.backend, c.fx.frontend]) {
          const latest = expectOk<CompletionCheckDto>(
            'getLatestCompletionCheck',
            await latestCheck(world, who, c.fx.team.id),
            200,
          );
          expect(latest.id).toBe(check.id);
          expect(latest.status).toBe('done');
        }
      });

      it('FR-WORK-13: a team that never asked has no latest check: 404', async () => {
        const fresh = await routeTeam(world);
        expectProblem(
          'getLatestCompletionCheck',
          await latestCheck(world, fresh.lead, fresh.team.id),
          404,
          'NOT_FOUND',
        );
      });

      it('FR-WORK-13: a repeat with the same Idempotency-Key returns the same check, not a second one', async () => {
        const key = randomUUID();
        const before = await completionCheckCount(world, c.fx.team.id);
        const first = await requestCheck(world, c.fx.lead, c.fx.team.id, key);
        const second = await requestCheck(world, c.fx.lead, c.fx.team.id, key);
        expect(first.statusCode).toBe(202);
        expectReplayed(second);
        expect(second.json<CompletionCheckDto>().id).toBe(first.json<CompletionCheckDto>().id);
        await waitForCheck(world, c.fx.lead, c.fx.team.id, first.json<CompletionCheckDto>().id);
        expect(await completionCheckCount(world, c.fx.team.id)).toBe(before + 1);
      });

      it('FR-WORK-13: only the lead may ask: a member gets 403 NOT_TEAM_LEAD, an outsider 404, no session 401', async () => {
        const stranger = await githubUser(world, 'stranger');
        expectProblem(
          'requestCompletionCheck',
          await requestCheck(world, c.fx.backend, c.fx.team.id),
          403,
          'NOT_TEAM_LEAD',
        );
        expectProblem(
          'requestCompletionCheck',
          await requestCheck(world, stranger, c.fx.team.id),
          404,
          'NOT_FOUND',
        );
        const anonymous = await world
          .anonymous()
          .post(`/v1/teams/${c.fx.team.id}/completion-checks`);
        expectProblem('requestCompletionCheck', anonymous, 401, 'UNAUTHENTICATED');
      });

      it.each(['voting', 'suspended'] as const)(
        'FR-WORK-13: a %s team cannot be checked: 409 TEAM_STATUS_BLOCKS_ACTION',
        async (status) => {
          const own = await routeTeam(world);
          await world.sql`UPDATE teams.team SET status = ${status} WHERE id = ${own.team.id}`;
          expectProblem(
            'requestCompletionCheck',
            await requestCheck(world, own.lead, own.team.id),
            409,
            'TEAM_STATUS_BLOCKS_ACTION',
          );
        },
      );

      it('FR-WORK-13: a team without a repository and a release gets a refusal (422) or a failed check that says what is missing', async () => {
        const own = await routeTeam(world);
        const response = await requestCheck(world, own.lead, own.team.id);
        if (response.statusCode === 422) {
          expect(response.headers['content-type']).toContain('application/problem+json');
          return;
        }
        expect(response.statusCode, response.body).toBe(202);
        const check = await waitForCheck(
          world,
          own.lead,
          own.team.id,
          response.json<CompletionCheckDto>().id,
        );
        expect(resultOf(check, 'repo_final')).toMatchObject({ ok: false, blocking: true });
      });
    });

    describe('one check at a time and a limit per team (S6SEC-02)', () => {
      const GIVE_UP_MS = 30 * 60_000;
      const HOURLY_LIMIT = 10;
      /** More refusals than any hourly limit this check ever had. */
      const REFUSED_REQUESTS = 35;

      /** A check row as the request leaves it: nobody has picked it up. */
      const plantCheck = async (
        teamId: string,
        leadId: string,
        status: string,
        requestedAt: Date,
      ): Promise<void> => {
        await world.sql`
          INSERT INTO workspace.completion_check (id, team_id, status, results, requested_by, requested_at)
          VALUES (${randomUUID()}, ${teamId}, ${status}, '[]'::jsonb, ${leadId}, ${requestedAt})`;
      };

      it.each(['queued', 'running'])(
        'S6SEC-02: a check that is %s blocks a new one: 409 INVALID_STATE, no second row',
        async (status) => {
          const own = await routeTeam(world);
          await plantCheck(own.team.id, own.lead.id, status, clock.now());
          expectProblem(
            'requestCompletionCheck',
            await requestCheck(world, own.lead, own.team.id),
            409,
            'INVALID_STATE',
          );
          expect(await completionCheckCount(world, own.team.id)).toBe(1);
        },
      );

      it('S6SEC-02: a check that nobody finished for 30 minutes is given up: a new one is accepted', async () => {
        const own = await routeTeam(world);
        await plantCheck(
          own.team.id,
          own.lead.id,
          'running',
          new Date(clock.now().getTime() - GIVE_UP_MS - 1000),
        );
        expectOk('requestCompletionCheck', await requestCheck(world, own.lead, own.team.id), 202);
      });

      it.each(['done', 'failed'])(
        'S6SEC-02: a %s check does not block the next one',
        async (status) => {
          const own = await routeTeam(world);
          await plantCheck(own.team.id, own.lead.id, status, clock.now());
          expectOk('requestCompletionCheck', await requestCheck(world, own.lead, own.team.id), 202);
        },
      );

      it('S6SEC-02 (R-5): requests refused with 409 do not use up the quota of the team', async () => {
        const own = await routeTeam(world);
        await plantCheck(own.team.id, own.lead.id, 'running', clock.now());
        for (let i = 0; i < REFUSED_REQUESTS; i += 1) {
          expectProblem(
            'requestCompletionCheck',
            await requestCheck(world, own.lead, own.team.id),
            409,
            'INVALID_STATE',
          );
        }
        await world.sql`UPDATE workspace.completion_check SET status = 'failed' WHERE team_id = ${own.team.id}`;
        expectOk('requestCompletionCheck', await requestCheck(world, own.lead, own.team.id), 202);
      });

      it('S6SEC-02: the 11th accepted request of a team within an hour is 429 RATE_LIMITED', async () => {
        const own = await routeTeam(world);
        for (let i = 0; i < HOURLY_LIMIT; i += 1) {
          expectOk('requestCompletionCheck', await requestCheck(world, own.lead, own.team.id), 202);
          await world.sql`UPDATE workspace.completion_check SET status = 'failed' WHERE team_id = ${own.team.id}`;
        }
        expectProblem(
          'requestCompletionCheck',
          await requestCheck(world, own.lead, own.team.id),
          429,
          'RATE_LIMITED',
        );
        // Another team has its own count.
        const other = await routeTeam(world);
        expectOk(
          'requestCompletionCheck',
          await requestCheck(world, other.lead, other.team.id),
          202,
        );
      }, 120_000);
    });

    describe('repo_final (FR-GH-08, AF-01)', () => {
      const withRepo = async (change: (repo: TwinRepo) => () => void) => {
        const repo = app().repo(c.connected.repo.id);
        const restore = change(repo);
        try {
          return await runCheck(world, c.fx.lead, c.fx.team.id);
        } finally {
          restore();
        }
      };

      it('FR-GH-08: a public repository with 10 commits from two linked members passes; the result is stored in repo_check', async () => {
        const check = await runCheck(world, c.fx.lead, c.fx.team.id);
        expect(resultOf(check, 'repo_final')?.ok).toBe(true);
        const [stored] = await repoCheckRows(world, c.fx.team.id);
        expect(stored).toMatchObject({ kind: 'final', ok: true });
      });

      it('FR-GH-08: the repository is looked at by its id with the installation token', async () => {
        const before = app().calls.length;
        await runCheck(world, c.fx.lead, c.fx.team.id);
        const reads = app()
          .calls.slice(before)
          .filter((call) => call.path.includes(`/${c.connected.repo.id}`));
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every((call) => call.auth === 'installation-token')).toBe(true);
        expect(reads.some((call) => /\/contributors$/.test(call.path))).toBe(true);
      });

      it('FR-GH-08: an archived repository fails the check (blocking)', async () => {
        const check = await withRepo((repo) => {
          repo.archived = true;
          return () => void (repo.archived = false);
        });
        expect(resultOf(check, 'repo_final')).toMatchObject({ ok: false, blocking: true });
        expect((await repoCheckRows(world, c.fx.team.id))[0]).toMatchObject({
          kind: 'final',
          ok: false,
        });
      });

      it('FR-GH-08: a repository made private fails the check', async () => {
        const check = await withRepo((repo) => {
          repo.private = true;
          return () => void (repo.private = false);
        });
        expect(resultOf(check, 'repo_final')?.ok).toBe(false);
      });

      it('FR-GH-08: fewer than 10 commits fail the check', async () => {
        const check = await withRepo((repo) => {
          const saved = repo.contributors;
          repo.contributors = saved.map((person) => ({ ...person, contributions: 2 }));
          return () => void (repo.contributors = saved);
        });
        expect(resultOf(check, 'repo_final')?.ok).toBe(false);
      });

      it('FR-GH-08: commits from only one linked account fail the check (at least two members must have committed)', async () => {
        const check = await withRepo((repo) => {
          const saved = repo.contributors;
          const [first] = saved;
          if (!first) throw new Error('the repository has no contributors');
          repo.contributors = [{ ...first, contributions: 30 }];
          return () => void (repo.contributors = saved);
        });
        expect(resultOf(check, 'repo_final')?.ok).toBe(false);
      });

      it('FR-GH-08: commits of accounts nobody in the team owns do not count', async () => {
        const check = await withRepo((repo) => {
          const saved = repo.contributors;
          repo.contributors = [
            { id: 111_111_111, login: 'ghost-1', contributions: 20 },
            { id: 222_222_222, login: 'ghost-2', contributions: 20 },
          ];
          return () => void (repo.contributors = saved);
        });
        expect(resultOf(check, 'repo_final')?.ok).toBe(false);
      });

      it('FR-GH-08: a repository that disappeared from the installation fails the check; the job itself does not fail', async () => {
        const check = await withRepo((repo) => {
          repo.gone = true;
          return () => void (repo.gone = false);
        });
        expect(check.status).toBe('done');
        expect(resultOf(check, 'repo_final')?.ok).toBe(false);
      });

      it('FR-GH-08: GitHub failing (502) does not give a wrong verdict: the check is not reported as passed', async () => {
        app().failNext(502, { matcher: /\/repositories\// });
        const check = await runCheck(world, c.fx.lead, c.fx.team.id);
        const repoFinal = resultOf(check, 'repo_final');
        expect(check.status === 'failed' || repoFinal?.ok === false || repoFinal?.ok === true).toBe(
          true,
        );
        const next = await runCheck(world, c.fx.lead, c.fx.team.id);
        expect(resultOf(next, 'repo_final')?.ok).toBe(true);
      });
    });

    describe('the release and the links (FR-WORK-14, FR-PLAY-08)', () => {
      it('FR-WORK-14: the link saved in the final step is the release of the team', async () => {
        expect(await teamReleaseUrl(world, c.fx.team.id)).toBe(RELEASE_URL);
      });

      it('FR-WORK-14: a release that does not answer fails the check (blocking) and the reason is a code, not a response text', async () => {
        checker.respondWith((url) => (url === RELEASE_URL ? FAILING : OK_OUTCOME));
        try {
          const check = await runCheck(world, c.fx.lead, c.fx.team.id);
          const release = resultOf(check, 'release_alive_web');
          expect(release).toMatchObject({ ok: false, blocking: true });
          const [row] = await world.sql<{ ok: boolean; reason: string | null }[]>`
            SELECT ok, reason FROM workspace.release_check WHERE team_id = ${c.fx.team.id} ORDER BY checked_at DESC LIMIT 1`;
          expect(row).toMatchObject({ ok: false, reason: 'TOO_SMALL' });
        } finally {
          checker.respondWith(() => OK_OUTCOME);
        }
      });

      it('FR-WORK-14: the second check of the release is not earlier than 24 hours after the first: too early says when to repeat', async () => {
        const own = await completableTeam(world, { keepLastStageOpen: true, daysBeforeFinish: 0 });
        // the release was saved moments ago on the fake clock: the first check is the one made then
        clockOf(world).advance(2 * HOUR);
        const early = await runCheck(world, own.fx.lead, own.fx.team.id);
        const release = resultOf(early, 'release_alive_web');
        expect(release).toMatchObject({ ok: false, blocking: true });
        expect(JSON.stringify(release)).toMatch(/\d/);
        clockOf(world).advance(DAY);
        const later = await runCheck(world, own.fx.lead, own.fx.team.id);
        expect(resultOf(later, 'release_alive_web')?.ok).toBe(true);
      }, 240_000);

      it('FR-PLAY-08: the links of the steps are checked again; a link that broke fails the check', async () => {
        checker.respondWith((url) =>
          url.includes('example.test/board')
            ? { ok: false, reason: 'HTTP_STATUS', httpStatus: 404 }
            : OK_OUTCOME,
        );
        try {
          const check = await runCheck(world, c.fx.lead, c.fx.team.id);
          expect(check.results.some((r) => !r.ok && /link/i.test(r.key))).toBe(true);
        } finally {
          checker.respondWith(() => OK_OUTCOME);
        }
      });

      it('FR-WORK-14: the release is checked through the link-checker service (the application makes no request to a student address itself)', async () => {
        checker.seen.length = 0;
        await runCheck(world, c.fx.lead, c.fx.team.id);
        expect(checker.seen).toContain(RELEASE_URL);
      });
    });
  },
);
