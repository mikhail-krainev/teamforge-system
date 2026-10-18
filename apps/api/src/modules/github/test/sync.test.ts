import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectRepository,
  GITHUB_SYNC_TASK,
  ghPerson,
  github,
  installApp,
  issueRef,
  link,
  pullRef,
  unlink,
  waitForContributions,
} from '../../../../test/fixtures/github.js';
import {
  accountCheckRow,
  contributionCount,
  contributionRows,
  syncStateRow,
} from '../../../../test/fixtures/github-db.js';
import { DAY } from '../../../../test/fixtures/teams.js';
import { routeTeam, startRouteWorld } from '../../../../test/fixtures/workspace.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';

/*
 * S6-02: the daily reconciliation with GitHub (FR-GH-06, FR-GH-08, FR-GH-09; architecture 7.4;
 * CC-11 "вебхук + сверка" is in test/concurrency/cc-11-webhook.test.ts). The task is run on demand the way
 * the other maintenance tasks are (World.runMaintenance); its name is `github-sync` (docs/plan.md S6-06) and
 * is a constant of test/fixtures/github.ts. Written before the implementation.
 */

describeInfra(
  'S6 github: daily reconciliation, ETag, rate limits, account checks (FR-GH-06, FR-GH-09)',
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

    const app = () => github(world).app;

    const linked = async () => {
      const fx = await routeTeam(world);
      const connected = await connectRepository(world, fx.team, [fx.backend, fx.frontend]);
      return {
        fx,
        repo: connected.repo,
        installationId: connected.installation.id,
        backend: await ghPerson(world, fx.backend),
        frontend: await ghPerson(world, fx.frontend),
      };
    };

    const sync = async () => {
      clock.advance(1000);
      await world.runMaintenance(GITHUB_SYNC_TASK);
    };

    describe('missed events are filled in (FR-GH-06)', () => {
      it('FR-GH-06: a closed issue whose webhook never came is found by the sync: one contribution with the assignee and the role', async () => {
        const t = await linked();
        const issue = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
        app().closeIssue(t.repo.id, issue.number);
        expect(await contributionCount(world, t.fx.team.id)).toBe(0);
        await sync();
        await waitForContributions(world, t.fx.team.id, 1);
        const [row] = await contributionRows(world, t.fx.team.id);
        expect(row).toMatchObject({
          user_id: t.fx.backend.id,
          source: 'issue',
          ref: issueRef(t.repo, issue.number),
          role_code: 'backend',
          active: true,
        });
      });

      it('FR-GH-06: a merged pull request that was missed is a contribution of its author, with the line counts read from GitHub', async () => {
        const t = await linked();
        const pull = app().openPull(t.repo.id, { author: t.frontend, additions: 77, deletions: 5 });
        app().mergePull(t.repo.id, pull.number);
        await sync();
        await waitForContributions(world, t.fx.team.id, 1, { source: 'pr' });
        const [row] = await contributionRows(world, t.fx.team.id);
        expect(row).toMatchObject({ user_id: t.fx.frontend.id, ref: pullRef(t.repo, pull.number) });
        const [stored] = await world.sql<{ additions: number | null; deletions: number | null }[]>`
          SELECT additions, deletions FROM github.gh_item
           WHERE repository_id = ${t.repo.id} AND kind = 'pr' AND number = ${pull.number}`;
        expect(stored).toMatchObject({ additions: 77, deletions: 5 });
      });

      it('FR-GH-06: running the sync twice gives no duplicates', async () => {
        const t = await linked();
        const issue = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
        app().closeIssue(t.repo.id, issue.number);
        await sync();
        await waitForContributions(world, t.fx.team.id, 1);
        await sync();
        expect(await contributionCount(world, t.fx.team.id)).toBe(1);
      });

      it('FR-GH-06: an issue reopened on GitHub since the last sync turns its contribution inactive', async () => {
        const t = await linked();
        const issue = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
        app().closeIssue(t.repo.id, issue.number);
        await sync();
        await waitForContributions(world, t.fx.team.id, 1);
        app().reopenIssue(t.repo.id, issue.number);
        await sync();
        await waitFor(
          async () => (await contributionCount(world, t.fx.team.id, { active: false })) === 1,
        );
        expect(await contributionCount(world, t.fx.team.id)).toBe(1);
      });

      it('FR-GH-06: pages are walked to the end (more closed issues than one GitHub page)', async () => {
        const t = await linked();
        for (let i = 0; i < 35; i += 1) {
          const issue = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
          app().closeIssue(t.repo.id, issue.number);
        }
        await sync();
        await waitFor(async () => (await contributionCount(world, t.fx.team.id)) === 35, 40_000);
      });

      it('FR-GH-06: a repository that is no longer linked is not read at all', async () => {
        const t = await linked();
        await unlink(world, t.fx.lead, t.fx.team.id);
        const before = app().calls.filter((call) => call.path.includes(String(t.repo.id))).length;
        await sync();
        const after = app().calls.filter((call) => call.path.includes(String(t.repo.id))).length;
        expect(after).toBe(before);
      });

      it('FR-GH-06: GitHub is read with the installation token (never the App JWT) and the progress is stored in repo_sync_state', async () => {
        const t = await linked();
        const issue = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
        app().closeIssue(t.repo.id, issue.number);
        const before = app().calls.length;
        await sync();
        const reads = app()
          .calls.slice(before)
          .filter((call) => call.path.includes(String(t.repo.id)));
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every((call) => call.auth === 'installation-token')).toBe(true);
        const state = await syncStateRow(world, t.repo.id);
        expect(state?.last_synced_at).not.toBeNull();
        expect(state?.issues_etag).toBeTruthy();
      });
    });

    describe('ETag and limits (FR-GH-06)', () => {
      it('FR-GH-06: a second run with nothing new gets 304 and costs no quota', async () => {
        const t = await linked();
        const issue = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
        app().closeIssue(t.repo.id, issue.number);
        await sync();
        await waitForContributions(world, t.fx.team.id, 1);
        const issuesPath = new RegExp(`/${t.repo.id}/issues$`);
        const before = app().callsTo(issuesPath).length;
        await sync();
        const second = app().callsTo(issuesPath).slice(before);
        expect(second.length).toBeGreaterThan(0);
        expect(second.every((call) => call.status === 304)).toBe(true);
        expect(await contributionCount(world, t.fx.team.id)).toBe(1);
      });

      it('FR-GH-06: Retry-After is obeyed: during the pause GitHub is not hammered, afterwards the sync catches up', async () => {
        const t = await linked();
        const issue = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
        app().closeIssue(t.repo.id, issue.number);
        app().throttle({ retryAfterSeconds: 120 });
        const before = app().calls.length;
        await sync();
        const during = app()
          .calls.slice(before)
          .filter((call) => call.status === 403);
        expect(during.length).toBeLessThanOrEqual(3);
        expect(await contributionCount(world, t.fx.team.id)).toBe(0);
        clock.advance(121_000);
        await sync();
        await waitForContributions(world, t.fx.team.id, 1);
      });

      it('FR-GH-06: a 429 with Retry-After is treated the same way', async () => {
        const t = await linked();
        const issue = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
        app().closeIssue(t.repo.id, issue.number);
        app().throttle({ retryAfterSeconds: 60, status: 429 });
        const before = app().calls.length;
        await sync();
        expect(
          app()
            .calls.slice(before)
            .filter((call) => call.status === 429).length,
        ).toBeLessThanOrEqual(3);
        clock.advance(61_000);
        await sync();
        await waitForContributions(world, t.fx.team.id, 1);
      });

      it('FR-GH-06: an exhausted hourly quota stops the sync until the reset; nothing is lost afterwards', async () => {
        const t = await linked();
        const issue = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
        app().closeIssue(t.repo.id, issue.number);
        app().exhaustQuota(3600);
        const before = app().calls.length;
        await sync();
        expect(app().calls.slice(before).length).toBeLessThanOrEqual(4);
        expect(await contributionCount(world, t.fx.team.id)).toBe(0);
        clock.advance(3601_000);
        await sync();
        await waitForContributions(world, t.fx.team.id, 1);
      });

      it('FR-GH-06: a one-off 5xx from GitHub does not lose the issue: the next run finds it', async () => {
        const t = await linked();
        const issue = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
        app().closeIssue(t.repo.id, issue.number);
        app().failNext(502, { matcher: /\/issues$/ });
        await sync();
        await sync();
        await waitForContributions(world, t.fx.team.id, 1);
      });
    });

    describe('account checks and CI (FR-GH-09, architecture 7.4)', () => {
      it('FR-GH-09: the GitHub accounts of the members are checked: creation date, public repositories, public activity', async () => {
        const t = await linked();
        app().addAccount({
          ...t.backend,
          type: 'User',
          createdAt: new Date(clock.now().getTime() - 5 * DAY).toISOString(),
          publicRepos: 0,
          publicEvents: 0,
        });
        app().addAccount({
          ...t.frontend,
          type: 'User',
          createdAt: '2019-03-01T00:00:00Z',
          publicRepos: 12,
          publicEvents: 40,
        });
        await sync();
        await waitFor(async () => (await accountCheckRow(world, t.backend.id)) !== undefined);
        const young = await accountCheckRow(world, t.backend.id);
        const old = await accountCheckRow(world, t.frontend.id);
        expect(young).toMatchObject({ public_repos: 0, has_public_activity: false });
        expect(Date.now() - (young?.account_created_at.getTime() ?? 0)).toBeGreaterThan(0);
        expect(young?.account_created_at.getTime()).toBeGreaterThan(
          clock.now().getTime() - 6 * DAY,
        );
        expect(old).toMatchObject({ public_repos: 12, has_public_activity: true });
      });

      it('architecture 7.4: ci_workflow reads the last runs; a successful run on the default branch is remembered', async () => {
        const t = await linked();
        app().setWorkflowRuns(t.repo.id, [
          { conclusion: 'failure', headBranch: 'feature', createdAt: clock.now().toISOString() },
          { conclusion: 'success', headBranch: 'main', createdAt: clock.now().toISOString() },
        ]);
        await sync();
        await waitFor(async () => (await syncStateRow(world, t.repo.id))?.ci_state != null);
        expect((await syncStateRow(world, t.repo.id))?.ci_state).toMatch(/success|ok|passed/i);
      });

      it('architecture 7.4: an installation without the Actions permission gives "not checked" (NULL), not an error', async () => {
        const fx = await routeTeam(world);
        const people = [await ghPerson(world, fx.backend), await ghPerson(world, fx.frontend)];
        const installed = await installApp(world, fx.lead, fx.team.id, {
          repos: [{ name: 'no-ci', contributors: people.map((p) => ({ ...p, contributions: 6 })) }],
        });
        app().setPermissions(installed.installation.id, {
          metadata: 'read',
          issues: 'read',
          pull_requests: 'read',
        });
        const repo = [...app().repos.values()].find(
          (r) => r.installationId === installed.installation.id,
        );
        if (!repo) throw new Error('missing repository');
        expect(
          (
            await link(world, fx.lead, fx.team.id, {
              installationId: installed.installation.id,
              repositoryId: repo.id,
            })
          ).statusCode,
        ).toBe(200);
        await sync();
        await waitFor(async () => (await syncStateRow(world, repo.id)) !== undefined);
        expect((await syncStateRow(world, repo.id))?.ci_state).toBeNull();
      });
    });
  },
);
