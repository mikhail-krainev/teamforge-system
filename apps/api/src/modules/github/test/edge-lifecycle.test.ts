import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebhookRequest } from '../../../../test/fakes/github-webhooks.js';
import {
  availableRepositories,
  callback,
  closedIssueDelivered,
  connectRepository,
  deliverAndWait,
  expectSetupGranted,
  getRepository,
  ghPerson,
  github,
  link,
  personalAccount,
  postWebhook,
  startSession,
  waitForDelivery,
} from '../../../../test/fixtures/github.js';
import {
  contributionCount,
  contributionRows,
  deliveryRows,
  ghItemRows,
  grantRows,
  outboxCount,
  repoLinkRows,
} from '../../../../test/fixtures/github-db.js';
import { expectOk } from '../../../../test/fixtures/teams.js';
import { routeTeam, startRouteWorld } from '../../../../test/fixtures/workspace.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';

/*
 * S6-12, edge cases of the life of an installation and of a repository (FR-GH-02, FR-GH-05, FR-GH-07,
 * SEC-02, SEC-06): the App removed or suspended, a repository renamed, moved, deleted or a fork, events
 * that name somebody else's installation, an issue deleted on GitHub, a delivery that is repeated after
 * the processor failed. The main flows are in webhook.test.ts and webhook-worker.test.ts.
 */

interface NotificationDto {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

describeInfra(
  'S6 github: installation and repository lifecycle, edge cases (S6-12)',
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
    type Linked = Awaited<ReturnType<typeof linked>>;

    /** Delivers a request and waits for the worker; returns the final status of the delivery. */
    const deliver = async (request: WebhookRequest): Promise<string> =>
      deliverAndWait(world, request);

    /** The same event, re-signed, with its payload changed on the way (a forged or confused sender). */
    const reshaped = (
      request: WebhookRequest,
      change: (payload: Record<string, unknown>) => void,
    ): WebhookRequest => {
      const payload = JSON.parse(request.body) as Record<string, unknown>;
      change(payload);
      return app().webhook(request.headers['x-github-event'] ?? '', payload);
    };

    const notificationsOf = async (who: Linked['fx']['lead']): Promise<NotificationDto[]> =>
      expectOk<{ items: NotificationDto[] }>(
        'listNotifications',
        await world.as(who).get('/v1/me/notifications'),
        200,
      ).items;

    describe('the App is removed (FR-GH-07, SEC-02)', () => {
      it('FR-GH-07: after installation.deleted the lead can neither list, link nor read the repository; the row says why', async () => {
        const t = await linked();
        app().uninstall(t.installationId);
        expect(await deliver(app().installationEvent('deleted', t.installationId))).toBe(
          'processed',
        );
        const [row] = await repoLinkRows(world, t.fx.team.id);
        expect(row).toMatchObject({ status: 'unlinked', unlink_reason: 'installation_deleted' });
        const [installation] = await world.sql<{ status: string }[]>`
        SELECT status FROM github.gh_installation WHERE installation_id = ${t.installationId}`;
        expect(installation?.status).toBe('deleted');
        expect(
          (await availableRepositories(world, t.fx.lead, t.fx.team.id, t.installationId))
            .statusCode,
        ).toBe(404);
        const relink = await link(world, t.fx.lead, t.fx.team.id, {
          installationId: t.installationId,
          repositoryId: t.repo.id,
        });
        expect(relink.statusCode).toBe(404);
        expect((await getRepository(world, t.fx.lead, t.fx.team.id)).statusCode).toBe(404);
      });

      it('FR-GH-07: the lead is told once, with ids and a code only, and a repeated delivery tells nobody again', async () => {
        const t = await linked();
        app().uninstall(t.installationId);
        const request = app().installationEvent('deleted', t.installationId);
        expect(await deliver(request)).toBe('processed');
        const told = await waitFor(async () => {
          const found = (await notificationsOf(t.fx.lead)).filter(
            (n) => n.type === 'repo_unlinked',
          );
          return found.length > 0 ? found : false;
        }, 20_000);
        expect(told).toHaveLength(1);
        expect(told[0]?.payload).toMatchObject({
          teamId: t.fx.team.id,
          reason: 'installation_deleted',
        });
        expect(JSON.stringify(told[0]?.payload)).not.toMatch(/full_?name|login/i);
        expect((await postWebhook(world, request)).statusCode).toBe(202);
        const second = app().installationEvent('deleted', t.installationId);
        expect(await deliver(second)).toBe('processed');
        expect(await outboxCount(world, 'repo_unlinked', t.fx.team.id)).toBe(1);
        expect(
          (await notificationsOf(t.fx.lead)).filter((n) => n.type === 'repo_unlinked'),
        ).toHaveLength(1);
      });

      it('FR-GH-07: the lead who unlinks the repository himself is not told about his own action', async () => {
        const t = await linked();
        expect(
          (await world.as(t.fx.lead).delete(`/v1/teams/${t.fx.team.id}/repository`)).statusCode,
        ).toBe(204);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(
          (await notificationsOf(t.fx.lead)).filter((n) => n.type === 'repo_unlinked'),
        ).toHaveLength(0);
      });

      it('SEC-06: installation.deleted for an installation nobody here ever granted is stored as ignored', async () => {
        const t = await linked();
        const stranger = app().installApp({
          id: 777_001,
          login: 'stranger-org',
          type: 'Organization',
        });
        app().uninstall(stranger.id);
        const request = app().installationEvent('deleted', stranger.id);
        expect(await deliver(request)).toBe('ignored');
        expect((await repoLinkRows(world, t.fx.team.id))[0]?.status).toBe('active');
      });

      it('FR-GH-07: the removal of one installation touches only its own teams', async () => {
        const a = await linked();
        const b = await linked();
        app().uninstall(a.installationId);
        await deliver(app().installationEvent('deleted', a.installationId));
        expect((await repoLinkRows(world, a.fx.team.id))[0]?.status).toBe('unlinked');
        expect((await repoLinkRows(world, b.fx.team.id))[0]?.status).toBe('active');
        expect((await grantRows(world, b.installationId)).every((g) => g.revoked_at === null)).toBe(
          true,
        );
        await closedIssueDelivered(world, b.repo, { author: b.backend, assignees: [b.backend] });
        expect(await contributionCount(world, b.fx.team.id)).toBe(1);
      });

      it('FR-GH-07: the App uninstalled without GitHub confirming the delivery (it names a live installation) changes nothing', async () => {
        const t = await linked();
        const request = app().installationEvent('deleted', t.installationId);
        expect(await deliver(request)).toBe('ignored');
        expect((await repoLinkRows(world, t.fx.team.id))[0]?.status).toBe('active');
        expect(
          (await availableRepositories(world, t.fx.lead, t.fx.team.id, t.installationId))
            .statusCode,
        ).toBe(200);
      });
    });

    describe('the App is suspended (FR-GH-07)', () => {
      it('SEC-06: a suspend that GitHub does not confirm is ignored: grants stay', async () => {
        const t = await linked();
        expect(await deliver(app().installationEvent('suspend', t.installationId))).toBe('ignored');
        expect((await grantRows(world, t.installationId)).every((g) => g.revoked_at === null)).toBe(
          true,
        );
      });

      it('FR-GH-07: unsuspend gives the installation its status back; the grant of the lead returns with a new pass through the setup', async () => {
        const t = await linked();
        app().suspend(t.installationId);
        expect(await deliver(app().installationEvent('suspend', t.installationId))).toBe(
          'processed',
        );
        expect(
          (await availableRepositories(world, t.fx.lead, t.fx.team.id, t.installationId))
            .statusCode,
        ).toBe(404);

        app().installation(t.installationId).suspendedAt = null;
        expect(await deliver(app().installationEvent('unsuspend', t.installationId))).toBe(
          'processed',
        );
        const [row] = await world.sql<{ status: string }[]>`
        SELECT status FROM github.gh_installation WHERE installation_id = ${t.installationId}`;
        expect(row?.status).toBe('active');
        expect((await repoLinkRows(world, t.fx.team.id))[0]?.status).toBe('active');

        const { state } = await startSession(world, t.fx.lead, t.fx.team.id);
        const person = await ghPerson(world, t.fx.lead);
        const again = app().install(person, personalAccount(person), { state });
        expectSetupGranted(await callback(world, t.fx.lead, again.query), world, t.installationId);
        expect(
          (await availableRepositories(world, t.fx.lead, t.fx.team.id, t.installationId))
            .statusCode,
        ).toBe(200);
      });

      it('FR-GH-07: while the installation is suspended a new delivery for the linked repository is still read as an event of the link', async () => {
        const t = await linked();
        app().suspend(t.installationId);
        await deliver(app().installationEvent('suspend', t.installationId));
        await closedIssueDelivered(world, t.repo, { author: t.backend, assignees: [t.backend] });
        expect(await contributionCount(world, t.fx.team.id)).toBe(1);
      });
    });

    describe('an event that names somebody else (SEC-06)', () => {
      it('SEC-06: repository.renamed for the repository of team A under the installation of team B does not rename it', async () => {
        const a = await linked();
        const b = await linked();
        const [before] = await repoLinkRows(world, a.fx.team.id);
        app().rename(a.repo.id, `forged-${randomUUID().slice(0, 6)}`);
        const forged = reshaped(app().repositoryEvent('renamed', a.repo.id), (payload) => {
          (payload['installation'] as { id: number }).id = b.installationId;
        });
        expect(await deliver(forged)).toBe('ignored');
        expect((await repoLinkRows(world, a.fx.team.id))[0]?.full_name).toBe(before?.full_name);
      });

      it('SEC-06: installation_repositories.removed naming the repository of A under the installation of B does not unlink A', async () => {
        const a = await linked();
        const b = await linked();
        app().removeRepo(a.repo.id);
        const forged = reshaped(
          app().repositoriesRemovedEvent(a.installationId, [a.repo.id]),
          (payload) => {
            (payload['installation'] as { id: number }).id = b.installationId;
          },
        );
        expect(await deliver(forged)).toBe('ignored');
        expect((await repoLinkRows(world, a.fx.team.id))[0]?.status).toBe('active');
        expect((await repoLinkRows(world, b.fx.team.id))[0]?.status).toBe('active');
      });

      it('SEC-06: a pull request event without an installation block is stored as ignored, not as a failure of the worker', async () => {
        const t = await linked();
        const item = app().openPull(t.repo.id, { author: t.backend });
        app().mergePull(t.repo.id, item.number);
        const request = reshaped(app().pullRequestEvent('closed', item), (payload) => {
          delete payload['installation'];
        });
        const response = await postWebhook(world, request);
        expect(response.statusCode).toBe(202);
        expect(await waitForDelivery(world, request.headers['x-github-delivery'] ?? '')).toBe(
          'ignored',
        );
        expect(await contributionCount(world, t.fx.team.id)).toBe(0);
      });
    });

    describe('a repository is renamed, moved or deleted (FR-GH-02, FR-GH-07)', () => {
      it('FR-GH-07: a rename keeps the link, the repository id and the contributions; the new name is shown and new events still count', async () => {
        const t = await linked();
        await closedIssueDelivered(world, t.repo, { author: t.backend, assignees: [t.backend] });
        app().rename(t.repo.id, `Renamed-Project-${randomUUID().slice(0, 4)}`);
        expect(await deliver(app().repositoryEvent('renamed', t.repo.id))).toBe('processed');
        const [row] = await repoLinkRows(world, t.fx.team.id);
        expect(row).toMatchObject({ status: 'active', repository_id: String(t.repo.id) });
        expect(row?.full_name).toBe(app().repo(t.repo.id).fullName);
        const shown = expectOk<{ fullName: string }>(
          'getRepository',
          await getRepository(world, t.fx.lead, t.fx.team.id),
          200,
        );
        expect(shown.fullName).toBe(app().repo(t.repo.id).fullName);
        await closedIssueDelivered(world, t.repo, { author: t.frontend, assignees: [t.frontend] });
        expect(await contributionCount(world, t.fx.team.id)).toBe(2);
      });

      it('FR-GH-07: renames arrive out of order: the older one delivered last does not bring the old name back', async () => {
        const t = await linked();
        app().rename(t.repo.id, `first-${randomUUID().slice(0, 6)}`);
        const stale = app().repositoryEvent('renamed', t.repo.id);
        app().rename(t.repo.id, `second-${randomUUID().slice(0, 6)}`);
        const fresh = app().repositoryEvent('renamed', t.repo.id);
        await deliver(fresh);
        await deliver(stale);
        expect((await repoLinkRows(world, t.fx.team.id))[0]?.full_name).toBe(
          app().repo(t.repo.id).fullName,
        );
      });

      it('FR-GH-07: a repository moved to another owner that the installation still reaches keeps the link under its new name', async () => {
        const t = await linked();
        app().repo(t.repo.id).fullName = 'new-owner/moved-project';
        expect(await deliver(app().repositoryEvent('transferred', t.repo.id))).toBe('processed');
        const [row] = await repoLinkRows(world, t.fx.team.id);
        expect(row).toMatchObject({ status: 'active', full_name: 'new-owner/moved-project' });
      });

      it('FR-GH-07: a repository moved out of reach of the installation is unlinked (repository_transferred), contributions stay', async () => {
        const t = await linked();
        await closedIssueDelivered(world, t.repo, { author: t.backend, assignees: [t.backend] });
        app().removeRepo(t.repo.id);
        expect(await deliver(app().repositoryEvent('transferred', t.repo.id))).toBe('processed');
        expect((await repoLinkRows(world, t.fx.team.id))[0]).toMatchObject({
          status: 'unlinked',
          unlink_reason: 'repository_transferred',
        });
        expect(await contributionCount(world, t.fx.team.id)).toBe(1);
      });

      it('FR-GH-07: a deleted repository (confirmed by GitHub) is unlinked with the reason repository_deleted and its id is free for another team', async () => {
        const t = await linked();
        app().removeRepo(t.repo.id);
        expect(await deliver(app().repositoryEvent('deleted', t.repo.id))).toBe('processed');
        expect((await repoLinkRows(world, t.fx.team.id))[0]?.unlink_reason).toBe(
          'repository_deleted',
        );
      });

      it('FR-GH-02: after a rename the repository is still taken by its id: another team gets 409 REPO_TAKEN', async () => {
        const t = await linked();
        app().rename(t.repo.id, `again-${randomUUID().slice(0, 6)}`);
        await deliver(app().repositoryEvent('renamed', t.repo.id));
        const other = await routeTeam(world);
        const person = await ghPerson(world, other.lead);
        const { state } = await startSession(world, other.lead, other.team.id);
        const result = app().install(person, personalAccount(person), { state });
        expectSetupGranted(
          await callback(world, other.lead, result.query),
          world,
          result.installation?.id ?? 0,
        );
        // The other lead has an installation of his own: the repository of the first one is not on it.
        const response = await link(world, other.lead, other.team.id, {
          installationId: result.installation?.id ?? 0,
          repositoryId: t.repo.id,
        });
        expect([409, 422]).toContain(response.statusCode);
        expect(await repoLinkRows(world, other.team.id)).toHaveLength(0);
      });
    });

    describe('forks and events nobody uses (FR-GH-02, SEC-06)', () => {
      it.each([
        ['fork', { forkee: { id: 1, full_name: 'someone/fork' } }],
        ['watch', { action: 'started' }],
        ['star', { action: 'created' }],
        ['push', { ref: 'refs/heads/main' }],
        ['create', { ref_type: 'branch' }],
      ])('SEC-06: a signed %s event is accepted and ignored', async (event, extra) => {
        const t = await linked();
        const request = app().webhook(event, {
          ...extra,
          repository: { id: t.repo.id, full_name: t.repo.fullName },
          installation: { id: t.installationId },
        });
        expect((await postWebhook(world, request)).statusCode).toBe(202);
        expect(await waitForDelivery(world, request.headers['x-github-delivery'] ?? '')).toBe(
          'ignored',
        );
        expect(await contributionCount(world, t.fx.team.id)).toBe(0);
      });

      it.each(['created', 'edited', 'publicized', 'unarchived'])(
        'SEC-06: repository.%s is not one of the handled actions: ignored, the link is untouched',
        async (action) => {
          const t = await linked();
          const base = JSON.parse(app().repositoryEvent('archived', t.repo.id).body) as Record<
            string,
            unknown
          >;
          const request = app().webhook('repository', { ...base, action });
          expect((await postWebhook(world, request)).statusCode).toBe(202);
          expect(await waitForDelivery(world, request.headers['x-github-delivery'] ?? '')).toBe(
            'ignored',
          );
          expect((await repoLinkRows(world, t.fx.team.id))[0]?.status).toBe('active');
        },
      );

      it('FR-GH-02: a fork with commits of its own works like any repository: its closed issue is a contribution', async () => {
        const fx = await routeTeam(world);
        const connected = await connectRepository(world, fx.team, [fx.backend, fx.frontend], {
          repo: { fork: true },
        });
        expect((await repoLinkRows(world, fx.team.id))[0]?.is_fork).toBe(true);
        const backend = await ghPerson(world, fx.backend);
        await closedIssueDelivered(world, connected.repo, {
          author: backend,
          assignees: [backend],
        });
        expect(await contributionCount(world, fx.team.id)).toBe(1);
      });
    });

    describe('an issue is deleted or moved on GitHub (FR-GH-05)', () => {
      it('FR-GH-05: issues.deleted is accepted and ignored: the contribution of the closed issue stays, nothing crashes', async () => {
        const t = await linked();
        const { item } = await closedIssueDelivered(world, t.repo, {
          author: t.backend,
          assignees: [t.backend],
        });
        app().deleteItem(t.repo.id, item.number);
        const request = app().issuesEvent('deleted', item);
        expect((await postWebhook(world, request)).statusCode).toBe(202);
        expect(await waitForDelivery(world, request.headers['x-github-delivery'] ?? '')).toBe(
          'ignored',
        );
        const rows = await contributionRows(world, t.fx.team.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.active).toBe(true);
        expect(await ghItemRows(world, t.repo.id)).toHaveLength(1);
      });

      it('FR-GH-05: issues.transferred is ignored as well', async () => {
        const t = await linked();
        const item = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
        const request = app().issuesEvent('transferred', item);
        expect((await postWebhook(world, request)).statusCode).toBe(202);
        expect(await waitForDelivery(world, request.headers['x-github-delivery'] ?? '')).toBe(
          'ignored',
        );
      });

      it('FR-GH-05: the pull request merged first and the issue it closes reported closed afterwards: both are contributions, no duplicates', async () => {
        const t = await linked();
        const issue = app().openIssue(t.repo.id, { author: t.backend, title: 'Баг' });
        const pull = app().openPull(t.repo.id, {
          author: t.frontend,
          body: `Fixes #${issue.number}`,
        });
        app().mergePull(t.repo.id, pull.number);
        await deliver(app().pullRequestEvent('closed', pull));
        app().closeIssue(t.repo.id, issue.number);
        const closed = app().issuesEvent('closed', issue);
        await deliver(closed);
        await deliver(app().webhook('issues', JSON.parse(closed.body)));
        const refs = (await contributionRows(world, t.fx.team.id)).map(
          (r) => `${r.ref}:${r.user_id}`,
        );
        expect(refs).toHaveLength(2);
        expect(new Set(refs).size).toBe(2);
      });
    });

    describe('a delivery is repeated after the processor failed (FR-GH-04)', () => {
      it('FR-GH-04: GitHub fails twice while the delivery is processed: the job is tried again and the effect is made once', async () => {
        const t = await linked();
        app().uninstall(t.installationId);
        const request = app().installationEvent('deleted', t.installationId);
        app().failNext(500, { matcher: /\/app\/installations\// });
        app().failNext(500, { matcher: /\/app\/installations\// });
        expect((await postWebhook(world, request)).statusCode).toBe(202);
        expect(
          await waitForDelivery(world, request.headers['x-github-delivery'] ?? '', 60_000),
        ).toBe('processed');
        const [row] = await deliveryRows(world, request.headers['x-github-delivery'] ?? '');
        expect(row?.attempts).toBeGreaterThanOrEqual(1);
        expect(await outboxCount(world, 'repo_unlinked', t.fx.team.id)).toBe(1);
      });

      it('FR-GH-04: the same delivery sent again while the first attempt failed does not run twice', async () => {
        const t = await linked();
        const item = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
        app().closeIssue(t.repo.id, item.number);
        const request = app().issuesEvent('closed', item);
        await Promise.all([postWebhook(world, request), postWebhook(world, request)]);
        await waitForDelivery(world, request.headers['x-github-delivery'] ?? '');
        await postWebhook(world, request);
        expect(await contributionCount(world, t.fx.team.id)).toBe(1);
        const [row] = await deliveryRows(world, request.headers['x-github-delivery'] ?? '');
        expect(row?.status).toBe('processed');
      });

      it('FR-GH-04: a delivery given up as failed stays failed when GitHub sends it again: 202, no second processing', async () => {
        const t = await linked();
        const item = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
        app().closeIssue(t.repo.id, item.number);
        const request = app().issuesEvent('closed', item);
        const deliveryId = request.headers['x-github-delivery'] ?? '';
        await world.sql`
        INSERT INTO github.webhook_delivery (delivery_id, event, action, installation_id, repository_id, payload, status, attempts, received_at)
        VALUES (${deliveryId}, 'issues', 'closed', ${t.installationId}, ${t.repo.id}, ${world.sql.json(JSON.parse(request.body))}, 'failed', 10, ${clock.now()})`;
        expect((await postWebhook(world, request)).statusCode).toBe(202);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect((await deliveryRows(world, deliveryId))[0]?.status).toBe('failed');
        expect(await contributionCount(world, t.fx.team.id)).toBe(0);
      });
    });
  },
);
