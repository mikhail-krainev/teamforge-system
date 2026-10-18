import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closedIssueDelivered,
  connectRepository,
  GITHUB_SYNC_TASK,
  ghPerson,
  github,
  issueRef,
  pullRef,
  waitForContributions,
} from '../../../../test/fixtures/github.js';
import {
  contributionCount,
  contributionRows,
  syncStateRow,
} from '../../../../test/fixtures/github-db.js';
import { routeTeam, startRouteWorld } from '../../../../test/fixtures/workspace.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

/*
 * S6-12, edge cases of the daily reconciliation (FR-GH-06, architecture 7.4): an installation that was
 * revoked or suspended while the run goes on, separate ETags of the two feeds, a Retry-After that is
 * zero or absurd, the pause shared by every background read, a renamed or emptied repository. The main
 * cases are in sync.test.ts.
 */

const PAUSE_KEY = 'gh_inst_token:rate-limit-pause';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_PAUSE_HOURS = 2;

describeInfra('S6 github: reconciliation, edge cases (S6-12)', ['db', 'redis'], () => {
  let world: World;
  let redis: Redis;
  const clock = new FakeClock(Date.now());

  beforeAll(async () => {
    world = await startRouteWorld({ github: true, clock });
    redis = new Redis(process.env.REDIS_URL ?? '', { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    await redis?.quit();
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

  const sync = async (task = GITHUB_SYNC_TASK) => {
    clock.advance(1000);
    await world.runMaintenance(task);
  };

  /** A pause is shared through Redis with every other test file: it must not outlive its test. */
  const forgetPause = async () => {
    await redis.del(PAUSE_KEY);
  };

  const missedIssue = (t: Awaited<ReturnType<typeof linked>>) => {
    const issue = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
    app().closeIssue(t.repo.id, issue.number);
    return issue;
  };

  describe('an installation is revoked while the sync goes on (FR-GH-07)', () => {
    it('FR-GH-06: the App uninstalled without a webhook costs that repository its turn; the other team is read as usual', async () => {
      const dead = await linked();
      const alive = await linked();
      missedIssue(dead);
      missedIssue(alive);
      app().uninstall(dead.installationId);
      await sync();
      await waitForContributions(world, alive.fx.team.id, 1);
      expect(await contributionCount(world, dead.fx.team.id)).toBe(0);
    });

    it('FR-GH-06: a suspended installation is skipped and read again as soon as it is unsuspended', async () => {
      const t = await linked();
      const other = await linked();
      missedIssue(t);
      missedIssue(other);
      app().suspend(t.installationId);
      await sync();
      await waitForContributions(world, other.fx.team.id, 1);
      expect(await contributionCount(world, t.fx.team.id)).toBe(0);
      app().installation(t.installationId).suspendedAt = null;
      await sync();
      await waitForContributions(world, t.fx.team.id, 1);
    });

    it('FR-GH-06: the installation revoked between two runs leaves the earlier contributions as they were', async () => {
      const t = await linked();
      await closedIssueDelivered(world, t.repo, { author: t.backend, assignees: [t.backend] });
      app().uninstall(t.installationId);
      await sync();
      await sync();
      const rows = await contributionRows(world, t.fx.team.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.active).toBe(true);
    });
  });

  describe('ETag, one feed at a time (FR-GH-06)', () => {
    it('FR-GH-06: the feeds have their own ETags: a new closed issue leaves the pulls feed at 304 and is still found', async () => {
      const t = await linked();
      await sync();
      const pullsPath = new RegExp(`/${t.repo.id}/pulls$`);
      const pullsBefore = app().callsTo(pullsPath).length;
      const issue = missedIssue(t);
      await sync();
      await waitForContributions(world, t.fx.team.id, 1);
      const pullCalls = app().callsTo(pullsPath).slice(pullsBefore);
      expect(pullCalls.length).toBeGreaterThan(0);
      expect(pullCalls.every((call) => call.status === 304)).toBe(true);
      expect((await contributionRows(world, t.fx.team.id))[0]?.ref).toBe(
        issueRef(t.repo, issue.number),
      );
    });

    it('FR-GH-06: a merged pull request after a quiet run is found although the stored ETags were fresh', async () => {
      const t = await linked();
      await sync();
      const pull = app().openPull(t.repo.id, { author: t.frontend });
      app().mergePull(t.repo.id, pull.number);
      await sync();
      await waitForContributions(world, t.fx.team.id, 1, { source: 'pr' });
      expect((await contributionRows(world, t.fx.team.id))[0]?.ref).toBe(
        pullRef(t.repo, pull.number),
      );
    });

    it('FR-GH-06: a change on GitHub renews the stored ETag, and the next quiet run is a 304 again', async () => {
      const t = await linked();
      await sync();
      const first = (await syncStateRow(world, t.repo.id))?.issues_etag;
      expect(first).toBeTruthy();
      missedIssue(t);
      await sync();
      await waitForContributions(world, t.fx.team.id, 1);
      const second = (await syncStateRow(world, t.repo.id))?.issues_etag;
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
      const before = app().callsTo(new RegExp(`/${t.repo.id}/issues$`)).length;
      await sync();
      const quiet = app()
        .callsTo(new RegExp(`/${t.repo.id}/issues$`))
        .slice(before);
      expect(quiet.every((call) => call.status === 304)).toBe(true);
    });

    it('FR-GH-06: a failed page does not store the ETag, so the change that was cut short is read on the next run', async () => {
      const t = await linked();
      await sync();
      const etag = (await syncStateRow(world, t.repo.id))?.issues_etag;
      missedIssue(t);
      app().failNext(502, { matcher: new RegExp(`/${t.repo.id}/issues$`) });
      await sync();
      expect((await syncStateRow(world, t.repo.id))?.issues_etag).toBe(etag);
      expect(await contributionCount(world, t.fx.team.id)).toBe(0);
      await sync();
      await waitForContributions(world, t.fx.team.id, 1);
    });
  });

  describe('limits (FR-GH-06)', () => {
    it('FR-GH-06: a 429 with Retry-After 0 is not "retry at once": the default pause holds the next run, the one after it goes through', async () => {
      const t = await linked();
      missedIssue(t);
      app().failNext(429, { retryAfter: 0, matcher: new RegExp(`/${t.repo.id}/`) });
      try {
        await sync();
        const during = app().calls.length;
        await sync();
        expect(app().calls.length).toBe(during);
        expect(await contributionCount(world, t.fx.team.id)).toBe(0);
        clock.advance(2 * MINUTE);
        await sync();
        await waitForContributions(world, t.fx.team.id, 1);
      } finally {
        await forgetPause();
      }
    });

    it('FR-GH-06: an absurd Retry-After (ten days) is capped: the sync tries again after two hours, not after ten days', async () => {
      const t = await linked();
      missedIssue(t);
      app().throttle({ retryAfterSeconds: 10 * 24 * 3600 });
      try {
        await sync();
        const paused = app().calls.length;
        clock.advance((MAX_PAUSE_HOURS * HOUR) / 2);
        await sync();
        expect(app().calls.length).toBe(paused);
        clock.advance(MAX_PAUSE_HOURS * HOUR);
        await sync();
        expect(app().calls.length).toBeGreaterThan(paused);
      } finally {
        await forgetPause();
        app().throttle({ retryAfterSeconds: 0 });
      }
    });

    it('FR-GH-06: the pause binds every background read: the hourly resume task and the other team wait for it too', async () => {
      const first = await linked();
      const second = await linked();
      missedIssue(first);
      missedIssue(second);
      app().throttle({ retryAfterSeconds: 300 });
      try {
        await sync();
        const paused = app().calls.length;
        clock.advance(MINUTE);
        await sync('github-sync-resume');
        expect(app().calls.length).toBe(paused);
        expect(await contributionCount(world, second.fx.team.id)).toBe(0);
        clock.advance(5 * MINUTE);
        await sync();
        await waitForContributions(world, first.fx.team.id, 1);
        await waitForContributions(world, second.fx.team.id, 1);
      } finally {
        await forgetPause();
      }
    });

    it('FR-GH-06: a 403 without Retry-After and with quota left is a missing permission, not a limit: no pause, the other repositories go on', async () => {
      const t = await linked();
      const other = await linked();
      missedIssue(t);
      missedIssue(other);
      app().failNext(403, { matcher: new RegExp(`/${t.repo.id}/`) });
      await sync();
      await waitForContributions(world, other.fx.team.id, 1);
      expect(await redis.get(PAUSE_KEY)).toBeNull();
    });
  });

  describe('what the sync finds on a changed repository (FR-GH-06, FR-GH-07)', () => {
    it('FR-GH-07: a repository renamed on GitHub is read by its id, not by its old name', async () => {
      const t = await linked();
      app().rename(t.repo.id, 'completely-new-name');
      const issue = missedIssue(t);
      await sync();
      await waitForContributions(world, t.fx.team.id, 1);
      expect((await contributionRows(world, t.fx.team.id))[0]?.ref).toBe(
        issueRef(t.repo, issue.number),
      );
    });

    it('FR-GH-05: an issue deleted on GitHub after it was counted stays counted; the sync neither fails nor revokes it', async () => {
      const t = await linked();
      const { item } = await closedIssueDelivered(world, t.repo, {
        author: t.backend,
        assignees: [t.backend],
      });
      app().deleteItem(t.repo.id, item.number);
      await sync();
      await sync();
      const rows = await contributionRows(world, t.fx.team.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.active).toBe(true);
    });

    it('FR-GH-05: an issue deleted before the sync ever saw it gives nothing', async () => {
      const t = await linked();
      const issue = missedIssue(t);
      app().deleteItem(t.repo.id, issue.number);
      await sync();
      expect(await contributionCount(world, t.fx.team.id)).toBe(0);
    });

    it('CC-11: two runs of the sync at the same moment make one contribution', async () => {
      const t = await linked();
      missedIssue(t);
      clock.advance(1000);
      await Promise.all([
        world.runMaintenance(GITHUB_SYNC_TASK),
        world.runMaintenance(GITHUB_SYNC_TASK),
      ]);
      await waitForContributions(world, t.fx.team.id, 1);
      expect(await contributionCount(world, t.fx.team.id)).toBe(1);
    });

    it('FR-GH-06: a closed pull request that was never merged gives nothing, a merged one gives exactly one contribution', async () => {
      const t = await linked();
      const dropped = app().openPull(t.repo.id, { author: t.backend });
      app().closePullUnmerged(t.repo.id, dropped.number);
      const merged = app().openPull(t.repo.id, { author: t.frontend });
      app().mergePull(t.repo.id, merged.number);
      await sync();
      await waitForContributions(world, t.fx.team.id, 1);
      await sync();
      expect((await contributionRows(world, t.fx.team.id)).map((r) => r.ref)).toEqual([
        pullRef(t.repo, merged.number),
      ]);
    });
  });
});
