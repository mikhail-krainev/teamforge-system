import { afterAll, beforeAll, expect, it } from 'vitest';
import { fireAll, tally } from '../fixtures/concurrency.js';
import {
  connectRepository,
  GITHUB_SYNC_TASK,
  ghPerson,
  github,
  issueRef,
  postWebhook,
  waitForContributions,
  waitForDelivery,
} from '../fixtures/github.js';
import {
  contributionCount,
  contributionRows,
  deliveryCount,
  deliveryRows,
} from '../fixtures/github-db.js';
import { expectNoDeadlocks } from '../fixtures/teams-db.js';
import { routeTeam, startRouteWorld } from '../fixtures/workspace.js';
import type { World } from '../fixtures/world.js';
import { FakeClock } from '../helpers/clock.js';
import { describeInfra, waitFor } from '../helpers/infra.js';

/*
 * CC-11, webhooks and the daily sync (FR-GH-04, FR-GH-05, FR-GH-06, S6-02; architecture 7.3, 7.4, 12.2):
 * `webhook_delivery.delivery_id` is the primary key (`INSERT ... ON CONFLICT DO NOTHING`), the contribution
 * has `contribution_uq (team_id, source, ref, user_id)`. One delivery x10 at once -> 1 row of the delivery,
 * 1 contribution; a webhook and the daily sync of the same issue at once -> 1 contribution. The idempotency
 * of webhooks is by X-GitHub-Delivery, not by Idempotency-Key (so there is no "paired key" test here: the
 * paired test is the re-delivery of the same id).
 */

describeInfra(
  'CC-11: one delivery, one contribution (FR-GH-04, FR-GH-05, FR-GH-06)',
  ['db', 'redis'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());
    let deadlocksBefore = 0;

    beforeAll(async () => {
      world = await startRouteWorld({ github: true, clock });
      deadlocksBefore = await world.deadlocks();
    });

    afterAll(async () => {
      if (!world) return;
      await expectNoDeadlocks(world, deadlocksBefore);
      await world.close();
    });

    const app = () => github(world).app;

    const pick = <T>(list: T[], index: number): T => {
      const found = list[index];
      if (found === undefined) throw new Error('fixture');
      return found;
    };

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

    it('CC-11: the same delivery x10 at once -> ten 202, 1 row of webhook_delivery, 1 contribution', async () => {
      const t = await linked();
      const item = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
      app().closeIssue(t.repo.id, item.number);
      const request = app().issuesEvent('closed', item);
      const fired = await fireAll(10, () => postWebhook(world, request));
      expect(tally(fired)).toEqual({ 202: 10 });
      const deliveryId = request.headers['x-github-delivery'] ?? '';
      await waitForDelivery(world, deliveryId);
      expect(await deliveryCount(world, deliveryId)).toBe(1);
      await waitForContributions(world, t.fx.team.id, 1);
      expect(await contributionCount(world, t.fx.team.id)).toBe(1);
      expect(
        await contributionCount(world, t.fx.team.id, { ref: issueRef(t.repo, item.number) }),
      ).toBe(1);
    });

    it('CC-11 (paired): the same delivery again after processing -> 202 and nothing changes', async () => {
      const t = await linked();
      const item = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
      app().closeIssue(t.repo.id, item.number);
      const request = app().issuesEvent('closed', item);
      await fireAll(10, () => postWebhook(world, request));
      await waitForContributions(world, t.fx.team.id, 1);
      const before = (await deliveryRows(world, request.headers['x-github-delivery'] ?? ''))[0];
      const again = await postWebhook(world, request);
      expect(again.statusCode).toBe(202);
      const after = (await deliveryRows(world, request.headers['x-github-delivery'] ?? ''))[0];
      expect(after?.status).toBe(before?.status);
      expect(await contributionCount(world, t.fx.team.id)).toBe(1);
    });

    it('CC-11: two assignees, ten identical deliveries -> still one contribution per assignee', async () => {
      const t = await linked();
      const item = app().openIssue(t.repo.id, {
        author: t.backend,
        assignees: [t.backend, t.frontend],
      });
      app().closeIssue(t.repo.id, item.number);
      const request = app().issuesEvent('closed', item);
      await fireAll(10, () => postWebhook(world, request));
      await waitForContributions(world, t.fx.team.id, 2);
      await waitForDelivery(world, request.headers['x-github-delivery'] ?? '');
      expect(await contributionCount(world, t.fx.team.id)).toBe(2);
    });

    it('CC-11: ten deliveries of the same closed issue under ten different ids -> ten delivery rows, one contribution', async () => {
      const t = await linked();
      const item = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
      app().closeIssue(t.repo.id, item.number);
      const requests = Array.from({ length: 10 }, () => app().issuesEvent('closed', item));
      const fired = await fireAll(10, (i) => postWebhook(world, pick(requests, i)));
      expect(tally(fired)).toEqual({ 202: 10 });
      await Promise.all(
        requests.map((r) => waitForDelivery(world, r.headers['x-github-delivery'] ?? '')),
      );
      expect(await contributionCount(world, t.fx.team.id)).toBe(1);
      const [row] = await contributionRows(world, t.fx.team.id);
      expect(row?.active).toBe(true);
    });

    it('CC-11: a webhook and the daily sync of the same issue at once -> one contribution', async () => {
      const t = await linked();
      const item = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
      app().closeIssue(t.repo.id, item.number);
      const request = app().issuesEvent('closed', item);
      clock.advance(1000);
      await Promise.all([postWebhook(world, request), world.runMaintenance(GITHUB_SYNC_TASK)]);
      await waitForContributions(world, t.fx.team.id, 1);
      await waitForDelivery(world, request.headers['x-github-delivery'] ?? '');
      clock.advance(1000);
      await world.runMaintenance(GITHUB_SYNC_TASK);
      expect(await contributionCount(world, t.fx.team.id)).toBe(1);
    });

    it('CC-11: the sync running twice and a webhook at once -> one contribution', async () => {
      const t = await linked();
      const item = app().openIssue(t.repo.id, { author: t.frontend, assignees: [t.frontend] });
      app().closeIssue(t.repo.id, item.number);
      const request = app().issuesEvent('closed', item);
      clock.advance(1000);
      await Promise.all([
        world.runMaintenance(GITHUB_SYNC_TASK),
        postWebhook(world, request),
        world.runMaintenance(GITHUB_SYNC_TASK),
      ]);
      await waitForContributions(world, t.fx.team.id, 1);
      await waitForDelivery(world, request.headers['x-github-delivery'] ?? '');
      expect(await contributionCount(world, t.fx.team.id)).toBe(1);
    });

    it('CC-11: ten different issues at once -> ten deliveries, ten contributions, no deadlock', async () => {
      const t = await linked();
      const requests = Array.from({ length: 10 }, (_, i) => {
        const who = i % 2 === 0 ? t.backend : t.frontend;
        const item = app().openIssue(t.repo.id, { author: who, assignees: [who] });
        app().closeIssue(t.repo.id, item.number);
        return app().issuesEvent('closed', item);
      });
      const fired = await fireAll(10, (i) => postWebhook(world, pick(requests, i)));
      expect(tally(fired)).toEqual({ 202: 10 });
      await waitFor(async () => (await contributionCount(world, t.fx.team.id)) === 10, 30_000);
      expect(await contributionCount(world, t.fx.team.id)).toBe(10);
    });

    it('CC-11: "closed" and "reopened" of one issue at once end in the state of the newer event, one row', async () => {
      const t = await linked();
      const item = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
      app().closeIssue(t.repo.id, item.number);
      const closed = app().issuesEvent('closed', item);
      app().reopenIssue(t.repo.id, item.number);
      const reopened = app().issuesEvent('reopened', item); // updated_at is later than the closed one
      await fireAll(2, (i) => postWebhook(world, i === 0 ? closed : reopened));
      await waitForDelivery(world, closed.headers['x-github-delivery'] ?? '');
      await waitForDelivery(world, reopened.headers['x-github-delivery'] ?? '');
      const [stored] = await world.sql<{ state: string }[]>`
      SELECT state FROM github.gh_item WHERE repository_id = ${t.repo.id} AND number = ${item.number}`;
      expect(stored?.state).toBe('open');
      expect(await contributionCount(world, t.fx.team.id, { active: true })).toBe(0);
      expect(await contributionCount(world, t.fx.team.id)).toBeLessThanOrEqual(1);
    });
  },
);
