import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectMatchesContract } from '../../../../test/helpers/contract.js';
import { hmacHex, type SignatureMode } from '../../../../test/fakes/github-webhooks.js';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import {
  closedIssueDelivered,
  connectRepository,
  deliverAndWait,
  ghPerson,
  github,
  issueRef,
  mergedPullDelivered,
  postWebhook,
  pullRef,
  unlink,
  waitForContributions,
  waitForDelivery,
} from '../../../../test/fixtures/github.js';
import {
  contributionCount,
  contributionRows,
  contributionsByRef,
  deliveryCount,
  deliveryRows,
  ghItemRows,
  grantRows,
  outboxCount,
  prReviewCount,
  repoLinkRows,
} from '../../../../test/fixtures/github-db.js';
import { DAY } from '../../../../test/fixtures/teams.js';
import { routeTeam, startRouteWorld } from '../../../../test/fixtures/workspace.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';

/*
 * S6-02: GitHub webhooks (FR-GH-03, FR-GH-04, FR-GH-05, FR-GH-07, SEC-06; CC-11 is in
 * test/concurrency/cc-11-webhook.test.ts). receiveGithubWebhook with the signature over the raw body, the
 * delivery table, the worker that turns issues and pull requests into contributions of the team that owns
 * the repository, the events of the installation. Written before the implementation.
 */

describeInfra(
  'S6 github: webhooks, signature, delivery log, contributions (FR-GH-03, FR-GH-04, FR-GH-05, FR-GH-07)',
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

    /** A started team with a linked repository whose commits come from the backend and frontend members. */
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

    const app = () => github(world).app;

    describe('signature (FR-GH-03)', () => {
      it.each<SignatureMode>([
        'invalid',
        'missing',
        'malformed',
        'wrong-secret',
        'sha1',
        'padded',
        'tampered',
      ])(
        'FR-GH-03: signature mode %s -> 401 SIGNATURE_INVALID, nothing is stored, nothing is processed',
        async (mode) => {
          const t = await linked();
          const item = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
          app().closeIssue(t.repo.id, item.number);
          const request = app().issuesEvent('closed', item, { signature: mode });
          const response = await postWebhook(world, request);
          expectProblem('receiveGithubWebhook', response, 401, 'SIGNATURE_INVALID');
          expect(await deliveryCount(world, request.headers['x-github-delivery'] ?? '')).toBe(0);
          expect(await contributionCount(world, t.fx.team.id)).toBe(0);
        },
      );

      it('FR-GH-03: a valid signature -> 202 with no body (the answer does not wait for processing)', async () => {
        const t = await linked();
        const item = app().openIssue(t.repo.id, { author: t.backend });
        const response = await postWebhook(world, app().issuesEvent('opened', item));
        expect(response.statusCode, response.body).toBe(202);
        expectMatchesContract('receiveGithubWebhook', response);
      });

      it('FR-GH-03: the signature is checked over the raw body: pretty-printed JSON signed as sent is accepted', async () => {
        const t = await linked();
        const item = app().openIssue(t.repo.id, { author: t.backend });
        const base = app().issuesEvent('opened', item);
        const pretty = JSON.stringify(JSON.parse(base.body), null, 2);
        const headers = {
          ...base.headers,
          'x-hub-signature-256': `sha256=${hmacHex(app().webhookSecret, pretty)}`,
        };
        const response = await postWebhook(world, { headers, body: pretty });
        expect(response.statusCode, response.body).toBe(202);
      });

      it('FR-GH-03: the same body signed by the secret of another application is refused', async () => {
        const t = await linked();
        const item = app().openIssue(t.repo.id, { author: t.backend });
        const request = app().webhook(
          'issues',
          JSON.parse(app().issuesEvent('opened', item).body),
          {
            secret: 'a-completely-different-secret',
          },
        );
        expectProblem(
          'receiveGithubWebhook',
          await postWebhook(world, request),
          401,
          'SIGNATURE_INVALID',
        );
      });

      it('FR-GH-03: the route needs neither a session, an Origin nor an Idempotency-Key (GitHub sends none)', async () => {
        const t = await linked();
        const item = app().openIssue(t.repo.id, { author: t.backend });
        const request = app().issuesEvent('opened', item);
        expect(Object.keys(request.headers)).not.toContain('idempotency-key');
        expect(Object.keys(request.headers)).not.toContain('origin');
        expect((await postWebhook(world, request)).statusCode).toBe(202);
      });

      it('FR-GH-03: a signed ping (App registration) is accepted and ignored', async () => {
        const request = app().webhook('ping', { zen: 'Keep it logically awesome.', hook_id: 1 });
        const response = await postWebhook(world, request);
        expect(response.statusCode, response.body).toBe(202);
        expect(await waitForDelivery(world, request.headers['x-github-delivery'] ?? '')).toBe(
          'ignored',
        );
      });

      it.each(['x-github-event', 'x-github-delivery'])(
        'FR-GH-03: a signed delivery without %s -> 400, nothing is stored',
        async (header) => {
          const t = await linked();
          const item = app().openIssue(t.repo.id, { author: t.backend });
          const request = app().issuesEvent('opened', item);
          delete request.headers[header];
          const response = await postWebhook(world, request);
          expect(response.statusCode, response.body).toBe(400);
        },
      );

      it('FR-GH-03: a signed body that is not JSON -> 400', async () => {
        const request = app().webhook('issues', {});
        const body = 'this is not json';
        request.headers['x-hub-signature-256'] = `sha256=${hmacHex(app().webhookSecret, body)}`;
        const response = await postWebhook(world, { headers: request.headers, body });
        expect(response.statusCode, response.body).toBe(400);
      });
    });

    describe('delivery log (FR-GH-04)', () => {
      it('FR-GH-04: a delivery for a linked repository is stored, processed and its payload is dropped', async () => {
        const t = await linked();
        const { deliveryId } = await closedIssueDelivered(world, t.repo, {
          author: t.backend,
          assignees: [t.backend],
        });
        const [row] = await deliveryRows(world, deliveryId);
        expect(row).toMatchObject({
          event: 'issues',
          action: 'closed',
          status: 'processed',
          payload: null,
        });
        expect(Number(row?.repository_id)).toBe(t.repo.id);
        expect(Number(row?.installation_id)).toBe(t.installationId);
      });

      it('FR-GH-04: the same delivery again -> 202, one row, one contribution', async () => {
        const t = await linked();
        const item = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
        app().closeIssue(t.repo.id, item.number);
        const request = app().issuesEvent('closed', item);
        expect((await postWebhook(world, request)).statusCode).toBe(202);
        await waitForContributions(world, t.fx.team.id, 1);
        const again = await postWebhook(world, request);
        expect(again.statusCode).toBe(202);
        const deliveryId = request.headers['x-github-delivery'] ?? '';
        expect(await deliveryCount(world, deliveryId)).toBe(1);
        expect(
          await contributionCount(world, t.fx.team.id, { ref: issueRef(t.repo, item.number) }),
        ).toBe(1);
      });

      it('FR-GH-04: a re-delivery after processing is also accepted and changes nothing', async () => {
        const t = await linked();
        const { item, deliveryId } = await closedIssueDelivered(world, t.repo, {
          author: t.backend,
          assignees: [t.backend],
        });
        const redelivery = app().issuesEvent('closed', item, { deliveryId });
        const response = await postWebhook(world, redelivery);
        expect(response.statusCode).toBe(202);
        expect(await deliveryCount(world, deliveryId)).toBe(1);
        expect((await deliveryRows(world, deliveryId))[0]?.status).toBe('processed');
        expect(await contributionCount(world, t.fx.team.id)).toBe(1);
      });

      it('SEC-06: an event for a repository nobody linked is stored as ignored without the payload and processes nothing', async () => {
        const fx = await routeTeam(world);
        const owner = await ghPerson(world, fx.lead);
        const installation = app().installApp({ id: owner.id, login: owner.login, type: 'User' });
        const stray = app().addRepo(installation.id, { name: `stray-${randomUUID().slice(0, 6)}` });
        const item = app().openIssue(stray.id, { author: owner, assignees: [owner] });
        app().closeIssue(stray.id, item.number);
        const request = app().issuesEvent('closed', item);
        expect((await postWebhook(world, request)).statusCode).toBe(202);
        const [row] = await deliveryRows(world, request.headers['x-github-delivery'] ?? '');
        expect(row).toMatchObject({ status: 'ignored', payload: null });
        expect(await contributionCount(world, fx.team.id)).toBe(0);
      });

      it('SEC-06: the sweeper re-queues a delivery stuck in `received` (the process died between insert and enqueue)', async () => {
        const t = await linked();
        const item = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
        app().closeIssue(t.repo.id, item.number);
        const request = app().issuesEvent('closed', item);
        const deliveryId = request.headers['x-github-delivery'] ?? '';
        await world.sql`
          INSERT INTO github.webhook_delivery (delivery_id, event, action, installation_id, repository_id, payload, status, attempts, received_at)
          VALUES (${deliveryId}, 'issues', 'closed', ${t.installationId}, ${t.repo.id}, ${world.sql.json(JSON.parse(request.body))}, 'received', 0, ${new Date(clock.now().getTime() - 120_000)})`;
        await world.runMaintenance('webhook-sweeper');
        expect(await waitForDelivery(world, deliveryId)).toBe('processed');
        expect(await contributionCount(world, t.fx.team.id)).toBe(1);
      });
    });

    describe('contributions from issues and pull requests (FR-GH-05)', () => {
      it('FR-GH-05: issue closed -> a contribution of the assignee with the role, the stage and the server time', async () => {
        const t = await linked();
        const { item } = await closedIssueDelivered(world, t.repo, {
          author: t.frontend,
          assignees: [t.backend],
          title: 'Починить авторизацию',
        });
        const [row] = await contributionRows(world, t.fx.team.id);
        expect(row).toMatchObject({
          user_id: t.fx.backend.id,
          source: 'issue',
          ref: issueRef(t.repo, item.number),
          title: 'Починить авторизацию',
          role_code: 'backend',
          role_locked: false,
          stage_ordinal: 1,
          active: true,
        });
        expect(Math.abs((row?.received_at.getTime() ?? 0) - clock.now().getTime())).toBeLessThan(
          60_000,
        );
      });

      it('FR-GH-05 / AF-23: received_at is the server time; the dates GitHub puts on the event are not used', async () => {
        const t = await linked();
        const longAgo = new Date(clock.now().getTime() - 40 * DAY);
        const item = app().openIssue(t.repo.id, {
          author: t.backend,
          assignees: [t.backend],
          at: longAgo,
        });
        app().closeIssue(t.repo.id, item.number, longAgo);
        await deliverAndWait(world, app().issuesEvent('closed', item));
        const [row] = await contributionRows(world, t.fx.team.id);
        expect(Math.abs((row?.received_at.getTime() ?? 0) - clock.now().getTime())).toBeLessThan(
          60_000,
        );
        expect(row?.occurred_at.getTime()).toBeLessThan(clock.now().getTime() - 30 * DAY);
      });

      it('FR-GH-05: several assignees -> a contribution for each of them (one row per user)', async () => {
        const t = await linked();
        const { item } = await closedIssueDelivered(world, t.repo, {
          author: t.backend,
          assignees: [t.backend, t.frontend],
        });
        const rows = await contributionRows(world, t.fx.team.id);
        expect(rows.map((r) => r.user_id).sort()).toEqual(
          [t.fx.backend.id, t.fx.frontend.id].sort(),
        );
        expect(rows.every((r) => r.ref === issueRef(t.repo, item.number))).toBe(true);
        expect(rows.map((r) => r.role_code).sort()).toEqual(['backend', 'frontend']);
      });

      it('FR-GH-05: an issue without assignees goes to the author of the pull request that closed it', async () => {
        const t = await linked();
        const issue = app().openIssue(t.repo.id, { author: t.backend, title: 'Баг в форме' });
        const pull = app().openPull(t.repo.id, {
          author: t.frontend,
          body: `Fixes #${issue.number}`,
        });
        app().mergePull(t.repo.id, pull.number);
        app().closeIssue(t.repo.id, issue.number);
        await deliverAndWait(world, app().pullRequestEvent('closed', pull));
        await deliverAndWait(world, app().issuesEvent('closed', issue));
        const mine = await contributionRows(world, t.fx.team.id);
        const byRef = new Map(mine.map((r) => [r.ref, r]));
        expect(byRef.get(issueRef(t.repo, issue.number))?.user_id).toBe(t.fx.frontend.id);
        expect(byRef.get(pullRef(t.repo, pull.number))?.user_id).toBe(t.fx.frontend.id);
      });

      it('FR-GH-05: an issue nobody was assigned to and no pull request closed is kept as an item but gives no contribution', async () => {
        const t = await linked();
        const { item } = await closedIssueDelivered(world, t.repo, { author: t.backend });
        const items = await ghItemRows(world, t.repo.id);
        expect(items.map((i) => [i.kind, i.number, i.state])).toEqual([
          ['issue', item.number, 'closed'],
        ]);
        expect(await contributionCount(world, t.fx.team.id)).toBe(0);
      });

      it('FR-GH-05: a merged pull request is a contribution of its author; the line counts are stored for AF-05', async () => {
        const t = await linked();
        const { item } = await mergedPullDelivered(world, t.repo, {
          author: t.frontend,
          additions: 120,
          deletions: 30,
          title: 'Страница входа',
        });
        const [row] = await contributionRows(world, t.fx.team.id);
        expect(row).toMatchObject({
          user_id: t.fx.frontend.id,
          source: 'pr',
          ref: pullRef(t.repo, item.number),
          role_code: 'frontend',
          active: true,
        });
        const [stored] = await ghItemRows(world, t.repo.id);
        expect(stored).toMatchObject({ kind: 'pr', merged: true, additions: 120, deletions: 30 });
      });

      it('FR-GH-05: a pull request closed without a merge gives no contribution', async () => {
        const t = await linked();
        const pull = app().openPull(t.repo.id, { author: t.frontend });
        app().closePullUnmerged(t.repo.id, pull.number);
        await deliverAndWait(world, app().pullRequestEvent('closed', pull));
        expect(await contributionCount(world, t.fx.team.id)).toBe(0);
      });

      it('FR-GH-05: an opened issue is only recorded: there is no contribution before it is closed', async () => {
        const t = await linked();
        const item = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
        await deliverAndWait(world, app().issuesEvent('opened', item));
        expect(await contributionCount(world, t.fx.team.id)).toBe(0);
        expect(await ghItemRows(world, t.repo.id)).toHaveLength(1);
      });

      it('FR-GH-05: an author whose GitHub account is not linked to a member is stored in gh_item without a contribution', async () => {
        const t = await linked();
        const stranger = { id: 987_654_321, login: 'someone-else' };
        const { item } = await closedIssueDelivered(world, t.repo, {
          author: stranger,
          assignees: [stranger],
        });
        const [stored] = await ghItemRows(world, t.repo.id);
        expect(stored?.number).toBe(item.number);
        expect(Number(stored?.assignee_github_ids[0])).toBe(stranger.id);
        expect(await contributionCount(world, t.fx.team.id)).toBe(0);
      });

      it('FR-GH-05: a member of another team who closes an issue here is nobody of this team: no contribution in either', async () => {
        const t = await linked();
        const other = await routeTeam(world);
        const outsider = await ghPerson(world, other.backend);
        await closedIssueDelivered(world, t.repo, { author: outsider, assignees: [outsider] });
        expect(await contributionCount(world, t.fx.team.id)).toBe(0);
        expect(await contributionCount(world, other.team.id)).toBe(0);
      });

      it('FR-WORK-17: a label role:<code> the member does not hold is ignored: the main role is used', async () => {
        const t = await linked();
        await closedIssueDelivered(world, t.repo, {
          author: t.backend,
          assignees: [t.backend],
          labels: ['role:designer'],
        });
        const [row] = await contributionRows(world, t.fx.team.id);
        expect(row?.role_code).toBe('backend');
      });

      it('FR-WORK-17: a label role:<code> of a role the member holds sets the role of the contribution', async () => {
        const t = await linked();
        await closedIssueDelivered(world, t.repo, {
          author: t.frontend,
          assignees: [t.frontend],
          labels: ['bug', 'role:frontend'],
        });
        expect((await contributionRows(world, t.fx.team.id))[0]?.role_code).toBe('frontend');
      });

      it('FR-GH-05: an issue reopened -> the contribution becomes inactive; closed again -> active again, still one row', async () => {
        const t = await linked();
        const { item } = await closedIssueDelivered(world, t.repo, {
          author: t.backend,
          assignees: [t.backend],
        });
        app().reopenIssue(t.repo.id, item.number);
        await deliverAndWait(world, app().issuesEvent('reopened', item));
        await waitFor(
          async () => (await contributionCount(world, t.fx.team.id, { active: false })) === 1,
        );
        app().closeIssue(t.repo.id, item.number);
        await deliverAndWait(world, app().issuesEvent('closed', item));
        await waitFor(
          async () => (await contributionCount(world, t.fx.team.id, { active: true })) === 1,
        );
        expect(await contributionCount(world, t.fx.team.id)).toBe(1);
      });

      it('SEC-06: deliveries out of order: an older `reopened` that arrives after a newer `closed` changes nothing', async () => {
        const t = await linked();
        const opened = new Date(clock.now().getTime() - 3 * DAY);
        const item = app().openIssue(t.repo.id, {
          author: t.backend,
          assignees: [t.backend],
          at: opened,
        });
        app().reopenIssue(t.repo.id, item.number, new Date(opened.getTime() + DAY));
        const staleReopen = app().issuesEvent('reopened', item); // updated_at = opened + 1 day
        app().closeIssue(t.repo.id, item.number, new Date(opened.getTime() + 2 * DAY));
        await deliverAndWait(world, app().issuesEvent('closed', item));
        await deliverAndWait(world, staleReopen);
        const [stored] = await ghItemRows(world, t.repo.id);
        expect(stored?.state).toBe('closed');
        expect(await contributionCount(world, t.fx.team.id, { active: true })).toBe(1);
      });

      it('FR-GH-05: a review of a pull request is stored once per reviewer (the checks `pr_cross_review` read it)', async () => {
        const t = await linked();
        const pull = app().openPull(t.repo.id, { author: t.backend });
        app().review(t.repo.id, pull.number, t.frontend, 'commented');
        await deliverAndWait(world, app().reviewEvent(pull));
        app().review(t.repo.id, pull.number, t.frontend, 'approved');
        await deliverAndWait(world, app().reviewEvent(pull));
        expect(await prReviewCount(world, t.repo.id)).toBe(1);
        const [row] = await world.sql<{ state: string }[]>`
          SELECT state FROM github.gh_pr_review WHERE repository_id = ${t.repo.id}`;
        expect(row?.state.toLowerCase()).toBe('approved');
      });

      it('SEC-06: a payload that does not fit the schema is accepted (202) and marked failed or ignored; nothing is created and the worker survives', async () => {
        const t = await linked();
        const item = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
        const good = JSON.parse(app().issuesEvent('closed', item).body) as Record<string, unknown>;
        const issue = { ...(good.issue as Record<string, unknown>) };
        delete issue.number;
        const request = app().webhook('issues', { ...good, issue });
        expect((await postWebhook(world, request)).statusCode).toBe(202);
        const status = await waitForDelivery(world, request.headers['x-github-delivery'] ?? '');
        expect(['failed', 'ignored']).toContain(status);
        expect(await contributionCount(world, t.fx.team.id)).toBe(0);
        const next = await closedIssueDelivered(world, t.repo, {
          author: t.backend,
          assignees: [t.backend],
        });
        expect(next.deliveryId).not.toBe('');
        expect(await contributionCount(world, t.fx.team.id)).toBe(1);
      });
    });

    describe('isolation between teams (SEC-06, FR-GH-02)', () => {
      it('a delivery for the repository of team A that names the installation of team B creates nothing in either team', async () => {
        const a = await linked();
        const b = await linked();
        const item = app().openIssue(a.repo.id, { author: a.backend, assignees: [a.backend] });
        app().closeIssue(a.repo.id, item.number);
        const request = app().issuesEvent('closed', item, { installationId: b.installationId });
        expect((await postWebhook(world, request)).statusCode).toBe(202);
        const status = await waitForDelivery(world, request.headers['x-github-delivery'] ?? '');
        expect(['ignored', 'failed']).toContain(status);
        expect(await contributionCount(world, a.fx.team.id)).toBe(0);
        expect(await contributionCount(world, b.fx.team.id)).toBe(0);
        expect(await contributionsByRef(world, issueRef(a.repo, item.number))).toEqual([]);
      });

      it('a contribution always lands in the team that owns the repository, whatever the sender claims', async () => {
        const a = await linked();
        const b = await linked();
        // the backend member of team B is credited on the repository of team A: B has no such member in A
        const outsider = await ghPerson(world, b.fx.backend);
        await closedIssueDelivered(world, a.repo, { author: outsider, assignees: [outsider] });
        expect(await contributionCount(world, a.fx.team.id)).toBe(0);
        expect(await contributionCount(world, b.fx.team.id)).toBe(0);
      });
    });

    describe('events of the installation (FR-GH-07, SEC-06)', () => {
      it('SEC-06: installation.deleted that GitHub does not confirm is ignored: the grant and the link stay', async () => {
        const t = await linked();
        const request = app().installationEvent('deleted', t.installationId);
        expect((await postWebhook(world, request)).statusCode).toBe(202);
        expect(await waitForDelivery(world, request.headers['x-github-delivery'] ?? '')).toBe(
          'ignored',
        );
        expect((await repoLinkRows(world, t.fx.team.id))[0]?.status).toBe('active');
        expect((await grantRows(world, t.installationId)).every((g) => g.revoked_at === null)).toBe(
          true,
        );
      });

      it('FR-GH-07: installation.deleted confirmed by GitHub -> grants revoked, repository unlinked, the lead is told, old contributions stay', async () => {
        const t = await linked();
        await closedIssueDelivered(world, t.repo, { author: t.backend, assignees: [t.backend] });
        app().uninstall(t.installationId);
        const request = app().installationEvent('deleted', t.installationId);
        expect((await postWebhook(world, request)).statusCode).toBe(202);
        expect(await waitForDelivery(world, request.headers['x-github-delivery'] ?? '')).toBe(
          'processed',
        );
        expect((await grantRows(world, t.installationId)).every((g) => g.revoked_at !== null)).toBe(
          true,
        );
        expect((await repoLinkRows(world, t.fx.team.id))[0]?.status).toBe('unlinked');
        await waitFor(async () => (await outboxCount(world, 'repo_unlinked', t.fx.team.id)) >= 1);
        expect(await contributionCount(world, t.fx.team.id)).toBe(1);
      });

      it('FR-GH-07: after the repository is unlinked by the installation event, new events give no contribution', async () => {
        const t = await linked();
        app().uninstall(t.installationId);
        const gone = app().installationEvent('deleted', t.installationId);
        await postWebhook(world, gone);
        await waitForDelivery(world, gone.headers['x-github-delivery'] ?? '');
        const item = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
        app().closeIssue(t.repo.id, item.number);
        const late = app().issuesEvent('closed', item);
        expect((await postWebhook(world, late)).statusCode).toBe(202);
        expect(await waitForDelivery(world, late.headers['x-github-delivery'] ?? '')).toBe(
          'ignored',
        );
        expect(await contributionCount(world, t.fx.team.id)).toBe(0);
      });

      it('FR-GH-07: installation_repositories.removed confirmed by GitHub unlinks the repository', async () => {
        const t = await linked();
        app().removeRepo(t.repo.id);
        const request = app().repositoriesRemovedEvent(t.installationId, [t.repo.id]);
        expect((await postWebhook(world, request)).statusCode).toBe(202);
        expect(await waitForDelivery(world, request.headers['x-github-delivery'] ?? '')).toBe(
          'processed',
        );
        expect((await repoLinkRows(world, t.fx.team.id))[0]?.status).toBe('unlinked');
        expect((await grantRows(world, t.installationId)).every((g) => g.revoked_at === null)).toBe(
          true,
        );
      });

      it('SEC-06: installation_repositories.removed that GitHub does not confirm is ignored', async () => {
        const t = await linked();
        const request = app().repositoriesRemovedEvent(t.installationId, [t.repo.id]);
        expect((await postWebhook(world, request)).statusCode).toBe(202);
        expect(await waitForDelivery(world, request.headers['x-github-delivery'] ?? '')).toBe(
          'ignored',
        );
        expect((await repoLinkRows(world, t.fx.team.id))[0]?.status).toBe('active');
      });

      it('FR-GH-07: repository.archived keeps the link (the final check fails by itself); repository.deleted that is not confirmed changes nothing', async () => {
        const t = await linked();
        app().archive(t.repo.id);
        const archived = app().repositoryEvent('archived', t.repo.id);
        await postWebhook(world, archived);
        await waitForDelivery(world, archived.headers['x-github-delivery'] ?? '');
        expect((await repoLinkRows(world, t.fx.team.id))[0]?.status).toBe('active');
        const deleted = app().repositoryEvent('deleted', t.repo.id);
        await postWebhook(world, deleted);
        expect(await waitForDelivery(world, deleted.headers['x-github-delivery'] ?? '')).toBe(
          'ignored',
        );
        expect((await repoLinkRows(world, t.fx.team.id))[0]?.status).toBe('active');
      });

      it('FR-GH-07: unlinking by the lead keeps the earlier contributions and stops new ones', async () => {
        const t = await linked();
        await closedIssueDelivered(world, t.repo, { author: t.backend, assignees: [t.backend] });
        expect((await unlink(world, t.fx.lead, t.fx.team.id)).statusCode).toBe(204);
        const item = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
        app().closeIssue(t.repo.id, item.number);
        const late = app().issuesEvent('closed', item);
        await postWebhook(world, late);
        expect(await waitForDelivery(world, late.headers['x-github-delivery'] ?? '')).toBe(
          'ignored',
        );
        expect(await contributionCount(world, t.fx.team.id)).toBe(1);
      });
    });
  },
);
