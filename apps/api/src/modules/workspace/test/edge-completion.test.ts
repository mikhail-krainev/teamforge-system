import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeLinkChecker, type FakeLinkChecker } from '../../../../test/fakes/link-checker.js';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import {
  complete,
  completableTeam,
  RELEASE_URL,
  requestCheck,
  runCheck,
  unmetCodes,
  type CompletableTeam,
  type CompletionCheckDto,
} from '../../../../test/fixtures/completion.js';
import {
  availableRepositories,
  deliverAndWait,
  github,
  link,
  unlink,
} from '../../../../test/fixtures/github.js';
import {
  completionCount,
  completionRows,
  forgetCompletion,
  outboxCount,
  repoLinkRows,
} from '../../../../test/fixtures/github-db.js';
import {
  patchItem,
  itemOf,
  routeTeam,
  startRouteWorld,
} from '../../../../test/fixtures/workspace.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

/*
 * S6-12, edge cases of the completion check and of completeProject (FR-WORK-13, FR-WORK-14, FR-GH-07,
 * FR-GH-08, AF-02, C-53): the 24 hours between two looks at the release, a release address that
 * changes, the lead who changes in the middle, an installation that is revoked or a GitHub that is down
 * before the last step, the repository replaced after the check, an address that already belongs to a
 * completed project. The refusals one condition at a time are in completion-blocks.test.ts.
 */

const HOUR = 3_600_000;
const RECHECK_MS = 24 * HOUR;
const OTHER_RELEASE = 'https://second.release.example.test/';

describeInfra(
  'S6 workspace: completion check and completeProject, edge cases (S6-12)',
  ['db', 'redis', 's3'],
  () => {
    let world: World;
    let checker: FakeLinkChecker;
    const clock = new FakeClock(Date.now());

    beforeAll(async () => {
      world = await startRouteWorld({ github: true, clock });
      checker = startFakeLinkChecker(world.queuePrefix);
    }, 120_000);

    afterAll(async () => {
      await checker?.close();
      if (!world) return;
      await world.close();
    });

    const app = () => github(world).app;
    const resultOf = (check: CompletionCheckDto, prefix: string) =>
      check.results.find((r) => r.key.startsWith(prefix));
    const releaseSeen = (url: string) => checker.seen.filter((u) => u === url).length;

    const firstLookOf = async (teamId: string, url: string): Promise<Date> => {
      const [row] = await world.sql<{ checked_at: Date }[]>`
        SELECT checked_at FROM workspace.release_check
         WHERE team_id = ${teamId} AND url = ${url} AND ok ORDER BY checked_at LIMIT 1`;
      if (!row) throw new Error('the release was never looked at');
      return row.checked_at;
    };

    const releaseChecks = async (teamId: string): Promise<number> => {
      const [row] = await world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM workspace.release_check WHERE team_id = ${teamId}`;
      return row?.n ?? 0;
    };

    describe('24 hours between two looks at the release (FR-WORK-14, C-53)', () => {
      let t: CompletableTeam;
      let firstLook: Date;

      beforeAll(async () => {
        t = await completableTeam(world, { keepLastStageOpen: true, daysBeforeFinish: 0 });
        firstLook = await firstLookOf(t.fx.team.id, RELEASE_URL);
      }, 240_000);

      it('FR-WORK-14: the first look is the save of the link; the second one is promised for exactly 24 hours later', async () => {
        const check = await runCheck(world, t.fx.lead, t.fx.team.id);
        const release = resultOf(check, 'release_alive');
        expect(release).toMatchObject({ ok: false, blocking: true });
        expect(release?.data).toMatchObject({
          reason: 'SECOND_CHECK_PENDING',
          nextCheckAt: new Date(firstLook.getTime() + RECHECK_MS).toISOString(),
        });
      });

      it('FR-WORK-14: one millisecond before the 24 hours the answer is the same and the address is not asked again', async () => {
        clock.set(new Date(firstLook.getTime() + RECHECK_MS - 1));
        const asked = releaseSeen(RELEASE_URL);
        const looks = await releaseChecks(t.fx.team.id);
        const check = await runCheck(world, t.fx.lead, t.fx.team.id);
        expect(resultOf(check, 'release_alive')).toMatchObject({ ok: false });
        expect(resultOf(check, 'release_alive')?.data).toMatchObject({
          reason: 'SECOND_CHECK_PENDING',
        });
        expect(releaseSeen(RELEASE_URL)).toBe(asked);
        expect(await releaseChecks(t.fx.team.id)).toBe(looks);
      });

      it('FR-WORK-13: while the second look is pending completeProject lists RELEASE_CHECK_FAILED with the date, and the team stays open', async () => {
        const response = await complete(world, t.fx.lead, t.fx.team.id);
        expectProblem('completeProject', response, 409, 'COMPLETION_BLOCKED');
        const release = response
          .json<{ unmet: { code: string; data?: Record<string, unknown> }[] }>()
          .unmet.find((u) => u.code === 'RELEASE_CHECK_FAILED');
        expect(release?.data).toMatchObject({ reason: 'SECOND_CHECK_PENDING' });
        expect(await completionCount(world, t.fx.team.id)).toBe(0);
      });

      it('FR-WORK-14: at exactly 24 hours the second look is made and passes; it is stored as the look of this check', async () => {
        clock.set(new Date(firstLook.getTime() + RECHECK_MS));
        const asked = releaseSeen(RELEASE_URL);
        const check = await runCheck(world, t.fx.lead, t.fx.team.id);
        const release = resultOf(check, 'release_alive');
        expect(release).toMatchObject({ ok: true, blocking: true });
        expect(release?.data).toMatchObject({ firstCheckedAt: firstLook.toISOString() });
        expect(releaseSeen(RELEASE_URL)).toBe(asked + 1);
        const [stored] = await world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM workspace.release_check
           WHERE team_id = ${t.fx.team.id} AND completion_check_id = ${check.id}`;
        expect(stored?.n).toBe(1);
      });

      it('FR-WORK-14: the release address changed by the lead after the check is not covered by it: RELEASE_CHECK_FAILED', async () => {
        const item = await itemOf(t.fx, 'mini_final_links', 3, t.fx.lead);
        const saved = await patchItem(world, t.fx.lead, t.fx.team.id, item.id, {
          version: item.version,
          linkUrl: OTHER_RELEASE,
        });
        expect(saved.statusCode, saved.body).toBe(200);
        const response = await complete(world, t.fx.lead, t.fx.team.id);
        expectProblem('completeProject', response, 409, 'COMPLETION_BLOCKED');
        expect(unmetCodes(response)).toContain('RELEASE_CHECK_FAILED');
      });

      it('FR-WORK-14: the new address starts its own 24 hours: a new check answers "pending" with a date counted from its first look', async () => {
        const check = await runCheck(world, t.fx.lead, t.fx.team.id);
        const release = resultOf(check, 'release_alive');
        expect(release).toMatchObject({ ok: false });
        const first = await firstLookOf(t.fx.team.id, OTHER_RELEASE);
        expect(release?.data).toMatchObject({
          reason: 'SECOND_CHECK_PENDING',
          url: OTHER_RELEASE,
          nextCheckAt: new Date(first.getTime() + RECHECK_MS).toISOString(),
        });
      });

      it('FR-WORK-14: putting the first address back needs no new wait: its first look is more than 24 hours old', async () => {
        const item = await itemOf(t.fx, 'mini_final_links', 3, t.fx.lead);
        await patchItem(world, t.fx.lead, t.fx.team.id, item.id, {
          version: item.version,
          linkUrl: RELEASE_URL,
        });
        const check = await runCheck(world, t.fx.lead, t.fx.team.id);
        expect(resultOf(check, 'release_alive')).toMatchObject({ ok: true });
      });
    });

    describe('the lead changes in the middle of the completion (FR-WORK-13, SEC-03)', () => {
      let t: CompletableTeam;

      beforeAll(async () => {
        t = await completableTeam(world);
      }, 240_000);

      it('FR-WORK-13: the check asked by the old lead is good for the new one; the old lead is a member now (403), the new lead completes', async () => {
        const requested = await requestCheck(world, t.fx.lead, t.fx.team.id);
        expect(requested.statusCode, requested.body).toBe(202);
        await world.sql`UPDATE teams.team SET lead_user_id = ${t.fx.backend.id} WHERE id = ${t.fx.team.id}`;
        const finished = await runCheck(world, t.fx.backend, t.fx.team.id);
        expect(finished.status).toBe('done');
        expectProblem(
          'completeProject',
          await complete(world, t.fx.lead, t.fx.team.id),
          403,
          'NOT_TEAM_LEAD',
        );
        expectProblem(
          'requestCompletionCheck',
          await requestCheck(world, t.fx.lead, t.fx.team.id),
          403,
          'NOT_TEAM_LEAD',
        );
        expect(await completionCount(world, t.fx.team.id)).toBe(0);
        const done = await complete(world, t.fx.backend, t.fx.team.id);
        expect(done.statusCode, done.body).toBe(201);
        const [row] = await completionRows(world, t.fx.team.id);
        expect(row?.completed_by).toBe(t.fx.backend.id);
        expect(await outboxCount(world, 'project_completed', t.fx.team.id)).toBe(1);
      });

      it('FR-WORK-17: after the completion nobody relabels: the same role is refused too (409), the lead and the owner alike', async () => {
        const [row] = await world.sql<{ id: string; user_id: string; role_code: string }[]>`
          SELECT id, user_id, role_code FROM workspace.contribution
           WHERE team_id = ${t.fx.team.id} AND active LIMIT 1`;
        if (!row) throw new Error('no contribution');
        const owner = [t.fx.backend, t.fx.frontend, t.fx.lead].find((u) => u.id === row.user_id);
        if (!owner) throw new Error('the owner of the contribution is not a fixture user');
        for (const who of [owner, t.fx.backend]) {
          const response = await world
            .as(who)
            .patch(`/v1/teams/${t.fx.team.id}/contributions/${row.id}`, {
              roleCode: row.role_code,
            });
          expect(response.statusCode, response.body).toBe(409);
        }
        const locked = await world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM workspace.contribution WHERE team_id = ${t.fx.team.id} AND NOT role_locked`;
        expect(locked[0]?.n).toBe(0);
      });

      it('FR-GH-06: the repository of a completed project is not read by the reconciliation any more', async () => {
        const reads = () =>
          app().calls.filter((call) => call.path.includes(String(t.connected.repo.id))).length;
        const before = reads();
        clock.advance(1000);
        await world.runMaintenance('github-sync');
        expect(reads()).toBe(before);
        expect((await repoLinkRows(world, t.fx.team.id))[0]?.status).toBe('completed');
      });
    });

    describe('GitHub and the installation before the last step (FR-GH-07, FR-GH-08)', () => {
      it('FR-GH-08: GitHub answers 5xx to the repository check: the result says GITHUB_UNAVAILABLE, is not ok, and completeProject refuses', async () => {
        const t = await completableTeam(world);
        for (let i = 0; i < 8; i += 1) app().failNext(502, { matcher: /\/repositories\// });
        const check = await runCheck(world, t.fx.lead, t.fx.team.id);
        expect(check.status).toBe('done');
        expect(resultOf(check, 'repo_final')).toMatchObject({ ok: false, blocking: true });
        expect(resultOf(check, 'repo_final')?.data).toMatchObject({ reason: 'GITHUB_UNAVAILABLE' });
        const response = await complete(world, t.fx.lead, t.fx.team.id);
        expectProblem('completeProject', response, 409, 'COMPLETION_BLOCKED');
        expect(unmetCodes(response)).toEqual(['REPO_FINAL_FAILED']);
        app().forcedFailures.length = 0;
        const next = await runCheck(world, t.fx.lead, t.fx.team.id);
        expect(resultOf(next, 'repo_final')).toMatchObject({ ok: true });
        expect((await complete(world, t.fx.lead, t.fx.team.id)).statusCode).toBe(201);
      }, 300_000);

      it('FR-GH-07: the installation is removed after a good check: the link is gone, completeProject says REPO_FINAL_FAILED, the team stays open and later the lead links again', async () => {
        const t = await completableTeam(world);
        await runCheck(world, t.fx.lead, t.fx.team.id);
        app().uninstall(t.connected.installation.id);
        const gone = app().installationEvent('deleted', t.connected.installation.id);
        expect(await deliverAndWait(world, gone)).toBe('processed');
        const response = await complete(world, t.fx.lead, t.fx.team.id);
        expectProblem('completeProject', response, 409, 'COMPLETION_BLOCKED');
        expect(unmetCodes(response)).toContain('REPO_FINAL_FAILED');
        expect(await completionCount(world, t.fx.team.id)).toBe(0);
        const fresh = await runCheck(world, t.fx.lead, t.fx.team.id);
        expect(resultOf(fresh, 'repo_final')).toMatchObject({ ok: false });
        const listed = await availableRepositories(
          world,
          t.fx.lead,
          t.fx.team.id,
          t.connected.installation.id,
        );
        expect(listed.statusCode).toBe(404);
      }, 300_000);

      it('FR-GH-08: the repository replaced after a good check: the old check does not cover the new repository, a new one does', async () => {
        const t = await completableTeam(world);
        await runCheck(world, t.fx.lead, t.fx.team.id);
        expect((await unlink(world, t.fx.lead, t.fx.team.id)).statusCode).toBe(204);
        const second = app().addRepo(t.connected.installation.id, {
          name: `replacement-${Date.now()}`,
          contributors: [
            { ...t.backend, contributions: 6 },
            { ...t.frontend, contributions: 6 },
          ],
        });
        const linked = await link(world, t.fx.lead, t.fx.team.id, {
          installationId: t.connected.installation.id,
          repositoryId: second.id,
        });
        expect(linked.statusCode, linked.body).toBe(200);
        const stale = await complete(world, t.fx.lead, t.fx.team.id);
        expectProblem('completeProject', stale, 409, 'COMPLETION_BLOCKED');
        expect(unmetCodes(stale)).toEqual(['REPO_FINAL_FAILED']);
        await runCheck(world, t.fx.lead, t.fx.team.id);
        const done = await complete(world, t.fx.lead, t.fx.team.id);
        expect(done.statusCode, done.body).toBe(201);
      }, 300_000);
    });

    describe('the release address of another project (AF-02)', () => {
      let t: CompletableTeam;

      beforeAll(async () => {
        t = await completableTeam(world);
        await runCheck(world, t.fx.lead, t.fx.team.id);
      }, 240_000);

      /** A team that is "completed" with this address; `completedAt` is a SQL expression of the database clock. */
      const plantCompleted = async (url: string, minutesFromNow: number): Promise<string> => {
        const earlier = await routeTeam(world);
        await world.sql`UPDATE teams.team SET status = 'completed', release_url = ${url} WHERE id = ${earlier.team.id}`;
        await world.sql`
          INSERT INTO workspace.project_completion (team_id, completed_at, planned_end_at, overdue_days, snapshot, completed_by)
          VALUES (${earlier.team.id}, now() + make_interval(mins => ${minutesFromNow}), now(), 0, '{}'::jsonb, ${earlier.lead.id})`;
        return earlier.team.id;
      };

      it.each([
        ['the same address', RELEASE_URL],
        ['the host in capitals and without the final slash', 'https://APP.Release.Example.test'],
        ['http instead of https and a query', 'http://app.release.example.test/?utm_source=x'],
        ['extra slashes at the end', 'https://app.release.example.test///'],
      ])(
        'AF-02: %s held by a project completed a minute ago -> exactly FRAUD_BLOCK',
        async (_title, url) => {
          const earlierId = await plantCompleted(url, -1);
          try {
            const response = await complete(world, t.fx.lead, t.fx.team.id);
            expectProblem('completeProject', response, 409, 'COMPLETION_BLOCKED');
            expect(unmetCodes(response)).toEqual(['FRAUD_BLOCK']);
          } finally {
            await forgetCompletion(world, earlierId);
            await world.sql`UPDATE teams.team SET release_url = NULL WHERE id = ${earlierId}`;
          }
          expect(await completionCount(world, t.fx.team.id)).toBe(0);
        },
      );

      it('AF-02: another path on the same host is another release: no block', async () => {
        const earlierId = await plantCompleted('https://app.release.example.test/other-app', -1);
        try {
          await runCheck(world, t.fx.lead, t.fx.team.id);
          const response = await complete(world, t.fx.lead, t.fx.team.id);
          expect(response.statusCode, response.body).toBe(201);
        } finally {
          await forgetCompletion(world, earlierId);
        }
      });
    });

    describe('template addresses (AF-02)', () => {
      let t: CompletableTeam;

      beforeAll(async () => {
        t = await completableTeam(world);
      }, 240_000);

      it.each([
        'https://example.com/my-app',
        'https://www.example.org/',
        'https://team7.example.net/demo',
        'http://localhost:3000/',
        'https://localhost./app',
      ])(
        'AF-02: the release %s is a template address: FRAUD_BLOCK among the refusals',
        async (url) => {
          await world.sql`UPDATE teams.team SET release_url = ${url} WHERE id = ${t.fx.team.id}`;
          try {
            await runCheck(world, t.fx.lead, t.fx.team.id);
            const response = await complete(world, t.fx.lead, t.fx.team.id);
            expectProblem('completeProject', response, 409, 'COMPLETION_BLOCKED');
            expect(unmetCodes(response)).toContain('FRAUD_BLOCK');
          } finally {
            await world.sql`UPDATE teams.team SET release_url = ${RELEASE_URL} WHERE id = ${t.fx.team.id}`;
          }
          expect(await completionCount(world, t.fx.team.id)).toBe(0);
        },
      );

      it.each([
        'https://example.com.evil.test/',
        'https://notexample.com/',
        'https://my-localhost.test/',
      ])('AF-02: %s only looks like a template: no FRAUD_BLOCK', async (url) => {
        await world.sql`UPDATE teams.team SET release_url = ${url} WHERE id = ${t.fx.team.id}`;
        try {
          await runCheck(world, t.fx.lead, t.fx.team.id);
          const response = await complete(world, t.fx.lead, t.fx.team.id);
          expect(unmetCodes(response)).not.toContain('FRAUD_BLOCK');
        } finally {
          await world.sql`UPDATE teams.team SET release_url = ${RELEASE_URL} WHERE id = ${t.fx.team.id}`;
        }
      });

      it('AF-02: a project that completes "in the future" of the database clock (a test clock ahead) does not hold its address', async () => {
        const earlier = await routeTeam(world);
        await world.sql`UPDATE teams.team SET status = 'completed', release_url = ${RELEASE_URL} WHERE id = ${earlier.team.id}`;
        await world.sql`
          INSERT INTO workspace.project_completion (team_id, completed_at, planned_end_at, overdue_days, snapshot, completed_by)
          VALUES (${earlier.team.id}, now() + interval '1 hour', now(), 0, '{}'::jsonb, ${earlier.lead.id})`;
        try {
          await runCheck(world, t.fx.lead, t.fx.team.id);
          const response = await complete(world, t.fx.lead, t.fx.team.id);
          expect(response.statusCode, response.body).toBe(201);
        } finally {
          await forgetCompletion(world, earlier.team.id);
        }
      });
    });
  },
);
