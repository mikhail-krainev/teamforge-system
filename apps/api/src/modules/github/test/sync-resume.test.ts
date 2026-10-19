import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectRepository,
  deliverAndWait,
  GITHUB_SYNC_TASK,
  ghPerson,
  github,
  issueRef,
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
 * H-3 of the slice 6 review: the reconciliation (FR-GH-06) must not lose the tail of a long history
 * (a run that stops at its page budget is not a finished run: the hourly resume continues from the
 * stored page) and must not drop a change that carries the same `updated_at` second as the stored one.
 * The page budget is 2 pages (200 items) per feed so that a long repository fits in a test.
 */

const RESUME_TASK = 'github-sync-resume';
const PAGE_BUDGET = 2;
const FILLER_ITEMS = 250;
const MINUTE = 60_000;

describeInfra(
  'S6 github: reconciliation resume and equal timestamps (H-3)',
  ['db', 'redis'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());

    beforeAll(async () => {
      world = await startRouteWorld({
        github: true,
        clock,
        env: { GITHUB_SYNC_MAX_PAGES: String(PAGE_BUDGET) },
      });
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
        backend: await ghPerson(world, fx.backend),
        frontend: await ghPerson(world, fx.frontend),
      };
    };

    const run = async (task: string) => {
      clock.advance(1000);
      await world.runMaintenance(task);
    };

    describe('a history longer than the page budget (H-3.1)', () => {
      it('FR-GH-06: the run that stops at the budget keeps its place, and the resume task reads the rest', async () => {
        const t = await linked();
        const start = clock.now().getTime() - 30 * MINUTE;
        // The oldest change on GitHub is a closed issue; 250 newer open issues push it past the budget.
        const oldest = app().openIssue(t.repo.id, {
          author: t.backend,
          assignees: [t.backend],
          at: new Date(start),
        });
        app().closeIssue(t.repo.id, oldest.number, new Date(start));
        for (let i = 1; i <= FILLER_ITEMS; i += 1) {
          app().openIssue(t.repo.id, { author: t.frontend, at: new Date(start + i * 1000) });
        }

        await run(GITHUB_SYNC_TASK);
        const afterFirst = await syncStateRow(world, t.repo.id);
        expect(afterFirst?.last_synced_at).toBeNull();
        expect(afterFirst?.issues_resume_page).toBe(PAGE_BUDGET + 1);
        expect(afterFirst?.pending_sync_started_at).not.toBeNull();
        expect(await contributionCount(world, t.fx.team.id)).toBe(0);

        await run(RESUME_TASK);
        await waitForContributions(world, t.fx.team.id, 1);
        expect((await contributionRows(world, t.fx.team.id))[0]?.ref).toBe(
          issueRef(t.repo, oldest.number),
        );
        const done = await syncStateRow(world, t.repo.id);
        expect(done?.issues_resume_page).toBeNull();
        expect(done?.pending_sync_started_at).toBeNull();
        expect(done?.last_synced_at).toEqual(afterFirst?.pending_sync_started_at);
      });

      it('FR-GH-06: a repository that was read to its end is left alone by the resume task', async () => {
        const t = await linked();
        app().openIssue(t.repo.id, { author: t.backend });
        await run(GITHUB_SYNC_TASK);
        const before = await syncStateRow(world, t.repo.id);
        expect(before?.last_synced_at).not.toBeNull();
        expect(before?.pending_sync_started_at).toBeNull();
        const mine = new RegExp(`/${t.repo.id}/`);
        const callsBefore = app().callsTo(mine).length;
        await run(RESUME_TASK);
        expect(app().callsTo(mine).length).toBe(callsBefore);
        expect((await syncStateRow(world, t.repo.id))?.last_synced_at).toEqual(
          before?.last_synced_at,
        );
      });
    });

    describe('two changes in one second (H-3.2)', () => {
      it('FR-GH-06: an issue closed in the second it was opened is found by the sync after the open state was stored', async () => {
        const t = await linked();
        const second = new Date(Math.floor(clock.now().getTime() / 1000) * 1000);
        const issue = app().openIssue(t.repo.id, {
          author: t.backend,
          assignees: [t.backend],
          at: second,
        });
        await run(GITHUB_SYNC_TASK);
        expect(await contributionCount(world, t.fx.team.id)).toBe(0);
        app().closeIssue(t.repo.id, issue.number, second);
        await run(GITHUB_SYNC_TASK);
        await waitForContributions(world, t.fx.team.id, 1);
        expect((await contributionRows(world, t.fx.team.id))[0]?.ref).toBe(
          issueRef(t.repo, issue.number),
        );
      });

      it('FR-GH-05: the closed webhook of the same second as the opened one is applied, not dropped as old', async () => {
        const t = await linked();
        const second = new Date(Math.floor(clock.now().getTime() / 1000) * 1000);
        const issue = app().openIssue(t.repo.id, {
          author: t.backend,
          assignees: [t.backend],
          at: second,
        });
        await deliverAndWait(world, app().issuesEvent('opened', issue));
        app().closeIssue(t.repo.id, issue.number, second);
        await deliverAndWait(world, app().issuesEvent('closed', issue));
        await waitForContributions(world, t.fx.team.id, 1);
      });

      it('FR-GH-05: a repeated delivery of the same second changes nothing: one contribution', async () => {
        const t = await linked();
        const second = new Date(Math.floor(clock.now().getTime() / 1000) * 1000);
        const issue = app().openIssue(t.repo.id, {
          author: t.backend,
          assignees: [t.backend],
          at: second,
        });
        app().closeIssue(t.repo.id, issue.number, second);
        await deliverAndWait(world, app().issuesEvent('closed', issue));
        await deliverAndWait(world, app().issuesEvent('closed', issue));
        await run(GITHUB_SYNC_TASK);
        await waitForContributions(world, t.fx.team.id, 1);
        expect(await contributionCount(world, t.fx.team.id)).toBe(1);
      });
    });
  },
);
