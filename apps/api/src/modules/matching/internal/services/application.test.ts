import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { githubIdentity } from '../../../../../test/fakes/github-server.js';
import type { UserFixture } from '../../../../../test/fixtures/index.js';
import { World } from '../../../../../test/fixtures/world.js';
import { codes, statuses } from '../../../../../test/helpers/http.js';
import { barrier, describeInfra } from '../../../../../test/helpers/infra.js';

const URL = '/v1/me/search-application';
const N = 10;

interface ApplicationBody {
  id: string;
  status: string;
  enqueuedAt: string;
  version: number;
  roles: { roleCode: string; priority: number; addedAt: string }[];
}

const role = (roleCode: string, priority: number) => ({ roleCode, priority });

describeInfra('S4-02 search application (FR-MATCH-03, FR-MATCH-04, CC-10)', ['db', 'redis'], () => {
  let world: World;

  beforeAll(async () => {
    world = await World.start({ worker: false });
    await world.ensureCatalog(['backend', 'qa', 'devops']);
  });

  afterAll(async () => {
    await world?.close();
  });

  async function candidate(github = true): Promise<UserFixture> {
    const name = `cand-${randomUUID().slice(0, 8)}`;
    return world.createUser(name, github ? { github: githubIdentity(name) } : {});
  }

  async function enqueue(user: UserFixture, roles = [role('backend', 1), role('qa', 2)]) {
    const response = await world.as(user).post(URL, { roles });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<ApplicationBody>();
  }

  const events = (applicationId: string) =>
    world.sql<{ status: string; user_id: string }[]>`
      SELECT payload->>'status' AS status, payload->>'userId' AS user_id
      FROM platform.outbox_event
      WHERE module = 'matching' AND type = 'application_changed' AND aggregate_id = ${applicationId}
      ORDER BY created_at, id`;

  describe('getMySearchApplication / createSearchApplication', () => {
    it('creates an active application with priorities, then returns it', async () => {
      const user = await candidate();
      const created = await enqueue(user, [role('qa', 2), role('backend', 1)]);
      expect(created).toMatchObject({ status: 'active', version: 1 });
      expect(created.roles.map((r) => [r.roleCode, r.priority])).toEqual([
        ['backend', 1],
        ['qa', 2],
      ]);
      const got = await world.as(user).get(URL);
      expect(got.statusCode).toBe(200);
      expect(got.json<ApplicationBody>()).toEqual(created);
      expect((await events(created.id)).map((e) => [e.status, e.user_id])).toEqual([
        ['active', user.id],
      ]);
    });

    it('answers 404 to a user who is not in the queue', async () => {
      const user = await candidate();
      expect((await world.as(user).get(URL)).statusCode).toBe(404);
    });

    it('shows the application only to its owner (self)', async () => {
      const owner = await candidate();
      await enqueue(owner);
      const other = await candidate();
      expect((await world.as(other).get(URL)).statusCode).toBe(404);
    });

    it('409 GITHUB_REQUIRED without a linked GitHub account; nothing is stored', async () => {
      const user = await candidate(false);
      const response = await world.as(user).post(URL, { roles: [role('backend', 1)] });
      expect(response.statusCode).toBe(409);
      expect(response.json<{ code: string }>().code).toBe('GITHUB_REQUIRED');
      const rows =
        await world.sql`SELECT 1 FROM matching.search_application WHERE user_id = ${user.id}`;
      expect(rows).toHaveLength(0);
    });

    it('409 APPLICATION_EXISTS for a second active application', async () => {
      const user = await candidate();
      await enqueue(user);
      const again = await world.as(user).post(URL, { roles: [role('devops', 1)] });
      expect(again.statusCode).toBe(409);
      expect(again.json<{ code: string }>().code).toBe('APPLICATION_EXISTS');
    });

    it('422 for a repeated priority, a repeated role and an unknown role', async () => {
      const user = await candidate();
      const samePriority = await world
        .as(user)
        .post(URL, { roles: [role('backend', 1), role('qa', 1)] });
      expect(samePriority.statusCode).toBe(422);
      const sameRole = await world
        .as(user)
        .post(URL, { roles: [role('backend', 1), role('backend', 2)] });
      expect(sameRole.statusCode).toBe(422);
      const unknown = await world.as(user).post(URL, { roles: [role('nosuchrole', 1)] });
      expect(unknown.statusCode).toBe(422);
    });

    it('400 for more than five roles or an empty list', async () => {
      const user = await candidate();
      const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((code, index) => role(code, (index % 5) + 1));
      expect((await world.as(user).post(URL, { roles: six })).statusCode).toBe(400);
      expect((await world.as(user).post(URL, { roles: [] })).statusCode).toBe(400);
    });

    it('CC-10: 10 parallel createSearchApplication give 1 application and 9 x 409 APPLICATION_EXISTS', async () => {
      const user = await candidate();
      const gate = barrier(N);
      const results = await Promise.allSettled(
        Array.from({ length: N }, async () => {
          await gate.wait();
          return world.as(user).post(URL, { roles: [role('backend', 1), role('qa', 2)] });
        }),
      );
      expect(statuses(results)).toEqual({ 201: 1, 409: N - 1 });
      expect(codes(results, 409)).toEqual(Array(N - 1).fill('APPLICATION_EXISTS'));
      const rows = await world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM matching.search_application
        WHERE user_id = ${user.id} AND status = 'active'`;
      expect(rows[0]?.n).toBe(1);
    });
  });

  describe('updateSearchApplication', () => {
    it('keeps enqueuedAt, stamps added_at of a new role with now, bumps the version', async () => {
      const user = await candidate();
      const created = await enqueue(user);
      const response = await world.as(user).put(URL, {
        version: created.version,
        roles: [role('backend', 1), role('qa', 2), role('devops', 3)],
      });
      expect(response.statusCode, response.body).toBe(200);
      const updated = response.json<ApplicationBody>();
      expect(updated.enqueuedAt).toBe(created.enqueuedAt);
      expect(updated.version).toBe(created.version + 1);
      const byCode = new Map(updated.roles.map((r) => [r.roleCode, r]));
      expect(byCode.get('backend')?.addedAt).toBe(created.roles[0]?.addedAt);
      expect(Date.parse(byCode.get('devops')?.addedAt ?? '')).toBeGreaterThan(
        Date.parse(created.enqueuedAt),
      );
      expect((await events(created.id)).map((e) => e.status)).toEqual(['active', 'active']);
    });

    it('swaps priorities in one save (deferred unique constraint)', async () => {
      const user = await candidate();
      const created = await enqueue(user);
      const response = await world
        .as(user)
        .put(URL, { version: created.version, roles: [role('backend', 2), role('qa', 1)] });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<ApplicationBody>().roles.map((r) => r.roleCode)).toEqual([
        'qa',
        'backend',
      ]);
    });

    it('drops a role: it leaves the application', async () => {
      const user = await candidate();
      const created = await enqueue(user);
      const response = await world
        .as(user)
        .put(URL, { version: created.version, roles: [role('qa', 1)] });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<ApplicationBody>().roles.map((r) => r.roleCode)).toEqual(['qa']);
    });

    it('an identical set of roles changes nothing: same version, no event', async () => {
      const user = await candidate();
      const created = await enqueue(user);
      const response = await world.as(user).put(URL, {
        version: created.version,
        roles: [role('qa', 2), role('backend', 1)],
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<ApplicationBody>().version).toBe(created.version);
      expect(await events(created.id)).toHaveLength(1);
    });

    it('409 VERSION_CONFLICT with the current state for a stale version', async () => {
      const user = await candidate();
      const created = await enqueue(user);
      const first = await world
        .as(user)
        .put(URL, { version: created.version, roles: [role('devops', 1)] });
      expect(first.statusCode).toBe(200);
      const stale = await world
        .as(user)
        .put(URL, { version: created.version, roles: [role('qa', 1)] });
      expect(stale.statusCode).toBe(409);
      const body = stale.json<{ code: string; current: ApplicationBody }>();
      expect(body.code).toBe('VERSION_CONFLICT');
      expect(body.current.roles.map((r) => r.roleCode)).toEqual(['devops']);
      expect(body.current.version).toBe(created.version + 1);
    });

    it('parallel updates with one version: exactly one wins, the rest are VERSION_CONFLICT', async () => {
      const user = await candidate();
      const created = await enqueue(user);
      const gate = barrier(5);
      const results = await Promise.allSettled(
        ['backend', 'qa', 'devops', 'backend', 'qa'].map(async (code) => {
          await gate.wait();
          return world.as(user).put(URL, { version: created.version, roles: [role(code, 1)] });
        }),
      );
      expect(statuses(results)).toEqual({ 200: 1, 409: 4 });
      expect(codes(results, 409)).toEqual(Array(4).fill('VERSION_CONFLICT'));
    });

    it('404 without an active application, 422 for a repeated priority', async () => {
      const user = await candidate();
      expect(
        (await world.as(user).put(URL, { version: 1, roles: [role('backend', 1)] })).statusCode,
      ).toBe(404);
      const created = await enqueue(user);
      const bad = await world
        .as(user)
        .put(URL, { version: created.version, roles: [role('backend', 1), role('qa', 1)] });
      expect(bad.statusCode).toBe(422);
    });
  });

  describe('cancelSearchApplication', () => {
    it('cancels: 204, the queue slot is free, the roles stop counting', async () => {
      const user = await candidate();
      const created = await enqueue(user);
      const response = await world.as(user).delete(URL);
      expect(response.statusCode).toBe(204);
      expect((await world.as(user).get(URL)).statusCode).toBe(404);
      const stored = await world.sql<{ status: string; cancelled_at: Date | null }[]>`
        SELECT status, cancelled_at FROM matching.search_application WHERE id = ${created.id}`;
      expect(stored[0]?.status).toBe('cancelled');
      expect(stored[0]?.cancelled_at).not.toBeNull();
      const active = await world.sql`
        SELECT 1 FROM matching.application_role WHERE application_id = ${created.id} AND is_active`;
      expect(active).toHaveLength(0);
      expect((await events(created.id)).map((e) => e.status)).toEqual(['active', 'cancelled']);
    });

    it('404 when there is nothing to cancel; update after cancel is 404 too', async () => {
      const user = await candidate();
      expect((await world.as(user).delete(URL)).statusCode).toBe(404);
      const created = await enqueue(user);
      await world.as(user).delete(URL);
      expect((await world.as(user).delete(URL)).statusCode).toBe(404);
      const update = await world
        .as(user)
        .put(URL, { version: created.version, roles: [role('qa', 1)] });
      expect(update.statusCode).toBe(404);
    });

    it('a new application after cancelling starts a new wait (new enqueuedAt, new id)', async () => {
      const user = await candidate();
      const first = await enqueue(user);
      await world.as(user).delete(URL);
      const second = await enqueue(user);
      expect(second.id).not.toBe(first.id);
      expect(Date.parse(second.enqueuedAt)).toBeGreaterThan(Date.parse(first.enqueuedAt));
    });

    it('a cancelling user cannot touch another user application', async () => {
      const owner = await candidate();
      const created = await enqueue(owner);
      const other = await candidate();
      expect((await world.as(other).delete(URL)).statusCode).toBe(404);
      const still = await world.sql<{ status: string }[]>`
        SELECT status FROM matching.search_application WHERE id = ${created.id}`;
      expect(still[0]?.status).toBe('active');
    });

    it('cancel racing update: either the update lands first or it sees 404', async () => {
      const user = await candidate();
      const created = await enqueue(user);
      const gate = barrier(2);
      const [cancel, update] = await Promise.all([
        gate.wait().then(() => world.as(user).delete(URL)),
        gate
          .wait()
          .then(() =>
            world.as(user).put(URL, { version: created.version, roles: [role('devops', 1)] }),
          ),
      ]);
      expect(cancel.statusCode).toBe(204);
      expect([200, 404]).toContain(update.statusCode);
    });
  });
});
