import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { hmacHex } from '../../../../test/fakes/github-webhooks.js';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import {
  connectRepository,
  deliverAndWait,
  ghPerson,
  github,
  issueRef,
  postWebhook,
  waitForDelivery,
  WEBHOOK_SWEEPER_TASK,
} from '../../../../test/fixtures/github.js';
import {
  contributionRows,
  deliveryCount,
  grantRows,
  repoLinkRows,
} from '../../../../test/fixtures/github-db.js';
import { routeTeam, startRouteWorld } from '../../../../test/fixtures/workspace.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

/*
 * S6-05, what the main suite (webhook.test.ts) leaves out: the order of a pull request and the issue it
 * closes, a renamed repository, a suspended installation, the size limit, the signature before the
 * body, and the sweeper after a failed job (backlog: the same job id is not queued again).
 */

describeInfra('S6 github: webhook worker, sweeper, limits (S6-05)', ['db', 'redis'], () => {
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

  it('FR-GH-05: the issue closed first and the pull request that closes it merged later -> the contribution of the pull request author', async () => {
    const t = await linked();
    const issue = app().openIssue(t.repo.id, { author: t.backend, title: 'Баг' });
    app().closeIssue(t.repo.id, issue.number);
    await deliverAndWait(world, app().issuesEvent('closed', issue));
    expect(await contributionRows(world, t.fx.team.id)).toHaveLength(0);
    const pull = app().openPull(t.repo.id, { author: t.frontend, body: `Closes #${issue.number}` });
    app().mergePull(t.repo.id, pull.number);
    await deliverAndWait(world, app().pullRequestEvent('closed', pull));
    const refs = (await contributionRows(world, t.fx.team.id)).map((r) => [r.ref, r.user_id]);
    expect(refs).toContainEqual([issueRef(t.repo, issue.number), t.fx.frontend.id]);
    expect(refs).toHaveLength(2);
  });

  it('FR-GH-07: a renamed repository keeps its link and gets the new name', async () => {
    const t = await linked();
    app().rename(t.repo.id, `renamed-${randomUUID().slice(0, 6)}`);
    const request = app().repositoryEvent('renamed', t.repo.id);
    await deliverAndWait(world, request);
    const [link] = await repoLinkRows(world, t.fx.team.id);
    expect(link?.status).toBe('active');
    expect(link?.full_name).toBe(app().repo(t.repo.id).fullName);
  });

  it('FR-GH-07: a suspended installation (confirmed by GitHub) loses its grants, the link stays', async () => {
    const t = await linked();
    app().suspend(t.installationId);
    const status = await deliverAndWait(
      world,
      app().installationEvent('suspend', t.installationId),
    );
    expect(status).toBe('processed');
    expect((await grantRows(world, t.installationId)).every((g) => g.revoked_at !== null)).toBe(
      true,
    );
    const [row] = await world.sql<{ status: string }[]>`
      SELECT status FROM github.gh_installation WHERE installation_id = ${t.installationId}`;
    expect(row?.status).toBe('suspended');
    expect((await repoLinkRows(world, t.fx.team.id))[0]?.status).toBe('active');
  });

  it('FR-GH-03: the signature is judged before the body: an unsigned body that is not JSON is 401, not 400', async () => {
    const response = await postWebhook(world, {
      headers: { 'x-github-event': 'issues', 'x-github-delivery': randomUUID() },
      body: 'this is not json',
    });
    expectProblem('receiveGithubWebhook', response, 401, 'SIGNATURE_INVALID');
  });

  it('SEC-06: a body over the limit is refused with 413 before anything is stored', async () => {
    const body = JSON.stringify({ zen: 'x'.repeat(5 * 1024 * 1024 + 1) });
    const deliveryId = randomUUID();
    const response = await postWebhook(world, {
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': `sha256=${hmacHex(app().webhookSecret, body)}`,
      },
      body,
    });
    expect(response.statusCode).toBe(413);
    expect(await deliveryCount(world, deliveryId)).toBe(0);
  });

  it('SEC-06: the sweeper queues a delivery again although a failed job with the same id is still kept', async () => {
    const t = await linked();
    const item = app().openIssue(t.repo.id, { author: t.backend, assignees: [t.backend] });
    app().closeIssue(t.repo.id, item.number);
    const request = app().issuesEvent('closed', item);
    const deliveryId = request.headers['x-github-delivery'] ?? '';
    await world.sql`
      INSERT INTO github.webhook_delivery (delivery_id, event, action, installation_id, repository_id, payload, status, attempts, received_at)
      VALUES (${deliveryId}, 'issues', 'closed', ${t.installationId}, ${t.repo.id}, ${world.sql.json(JSON.parse(request.body))}, 'received', 0, ${new Date(clock.now().getTime() - 120_000)})`;
    const connection = new Redis(process.env.REDIS_URL ?? '', { maxRetriesPerRequest: null });
    const queue = new Queue('github-webhook', { connection, prefix: world.queuePrefix });
    try {
      // A job under the delivery id that failed for good (no `deliveryId` in its data).
      await queue.add('process-delivery', {}, { jobId: deliveryId, attempts: 1 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await (await queue.getJob(deliveryId))?.getState()).toBe('failed');
      await world.runMaintenance(WEBHOOK_SWEEPER_TASK);
      expect(await waitForDelivery(world, deliveryId)).toBe('processed');
    } finally {
      await queue.close();
      connection.disconnect();
    }
    expect((await contributionRows(world, t.fx.team.id)).map((r) => r.ref)).toEqual([
      issueRef(t.repo, item.number),
    ]);
  });
});
