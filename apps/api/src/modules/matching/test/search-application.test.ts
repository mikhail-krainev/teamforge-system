import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import {
  activeApplications,
  applicationRoles,
  applicationRow,
  applicationsOf,
} from '../../../../test/fixtures/matching-db.js';
import {
  applicationBody,
  candidate,
  DAY,
  freshRole,
  searchApplication,
  type SearchApplicationDto,
} from '../../../../test/fixtures/matching.js';
import { expectOk } from '../../../../test/fixtures/teams.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { expectCode, startWorld } from './support.js';

const URL = '/v1/me/search-application';

describeInfra(
  'S4 matching: the search application (FR-MATCH-03, FR-MATCH-04, FR-AUTH-05)',
  ['db', 'redis'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());

    beforeAll(async () => {
      // No worker: the queue must not act on the applications built here (auto-add has its own suite).
      world = await startWorld({ clock, worker: false });
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    describe('getMySearchApplication', () => {
      it('FR-MATCH-03: no active application -> 404 APPLICATION_NOT_FOUND', async () => {
        const user = await candidate(world, 'get-none', { roles: [] });
        expectProblem(
          'getMySearchApplication',
          await world.as(user).get(URL),
          404,
          'APPLICATION_NOT_FOUND',
        );
      });

      it('FR-MATCH-03: returns the own active application (200, contract schema)', async () => {
        const role = await freshRole(world);
        const { user, application } = await searchApplication(world, { roles: [role] });
        const got = expectOk<SearchApplicationDto>(
          'getMySearchApplication',
          await world.as(user).get(URL),
          200,
        );
        expect(got).toEqual(application);
      });
    });

    describe('createSearchApplication', () => {
      it('FR-MATCH-03: 1 role -> 201 with status active, priority 1, version 1, enqueuedAt and addedAt set', async () => {
        const role = await freshRole(world);
        const user = await candidate(world, 'create-one', { roles: [role] });
        const created = expectOk<SearchApplicationDto>(
          'createSearchApplication',
          await world.as(user).post(URL, applicationBody([role])),
          201,
        );
        expect(created).toMatchObject({ status: 'active', version: 1 });
        expect(created.roles).toHaveLength(1);
        expect(created.roles[0]).toMatchObject({ roleCode: role, priority: 1 });
        expect(Math.abs(Date.parse(created.enqueuedAt) - clock.now().getTime())).toBeLessThan(
          60_000,
        );
        expect(created.roles[0]?.addedAt).toBeDefined();
        expect(await activeApplications(world, user.id)).toBe(1);
      });

      it('FR-MATCH-03: 5 roles with unique priorities 1..5 are stored in that order (C-07)', async () => {
        const roles = [
          await freshRole(world),
          await freshRole(world),
          await freshRole(world),
          await freshRole(world),
          await freshRole(world),
        ];
        const user = await candidate(world, 'create-five', { roles });
        const created = expectOk<SearchApplicationDto>(
          'createSearchApplication',
          await world.as(user).post(URL, applicationBody(roles)),
          201,
        );
        expect(
          [...created.roles].sort((a, b) => a.priority - b.priority).map((r) => r.roleCode),
        ).toEqual(roles);
        expect((await applicationRoles(world, created.id)).map((r) => r.priority)).toEqual([
          1, 2, 3, 4, 5,
        ]);
      });

      it('FR-MATCH-03: 6 roles, no roles, priority outside 1..5 -> 400 VALIDATION_FAILED (schema)', async () => {
        const roles = [
          await freshRole(world),
          await freshRole(world),
          await freshRole(world),
          await freshRole(world),
          await freshRole(world),
          await freshRole(world),
        ];
        const user = await candidate(world, 'create-bad-shape', { roles });
        const caller = world.as(user);
        expectProblem(
          'createSearchApplication',
          await caller.post(URL, {
            roles: roles.map((roleCode, i) => ({ roleCode, priority: Math.min(i + 1, 5) })),
          }),
          400,
          'VALIDATION_FAILED',
        );
        expectProblem(
          'createSearchApplication',
          await caller.post(URL, { roles: [] }),
          400,
          'VALIDATION_FAILED',
        );
        expectProblem(
          'createSearchApplication',
          await caller.post(URL, { roles: [{ roleCode: roles[0], priority: 6 }] }),
          400,
          'VALIDATION_FAILED',
        );
        expectProblem(
          'createSearchApplication',
          await caller.post(URL, { roles: [{ roleCode: roles[0], priority: 0 }] }),
          400,
          'VALIDATION_FAILED',
        );
        expect(await applicationsOf(world, user.id)).toEqual([]);
      });

      it('FR-MATCH-03: a repeated priority, a repeated role, a role outside the catalog -> 422 and no application', async () => {
        const [a, b] = [await freshRole(world), await freshRole(world)];
        const user = await candidate(world, 'create-bad-values', { roles: [a, b] });
        const caller = world.as(user);
        const samePriority = await caller.post(URL, {
          roles: [
            { roleCode: a, priority: 1 },
            { roleCode: b, priority: 1 },
          ],
        });
        expectCode(samePriority, 422);
        const sameRole = await caller.post(URL, {
          roles: [
            { roleCode: a, priority: 1 },
            { roleCode: a, priority: 2 },
          ],
        });
        expectCode(sameRole, 422);
        const unknown = await caller.post(URL, {
          roles: [{ roleCode: 'no_such_role', priority: 1 }],
        });
        expectCode(unknown, 422);
        expect(await applicationsOf(world, user.id)).toEqual([]);
      });

      it('FR-MATCH-03: an unknown field in the body -> 400 (additionalProperties: false)', async () => {
        const role = await freshRole(world);
        const user = await candidate(world, 'create-extra-field', { roles: [role] });
        const response = await world
          .as(user)
          .post(URL, { ...applicationBody([role]), enqueuedAt: '2020-01-01T00:00:00Z' });
        expectProblem('createSearchApplication', response, 400, 'VALIDATION_FAILED');
      });

      it('FR-MATCH-03: a second application while one is active -> 409 APPLICATION_EXISTS, the first is unchanged', async () => {
        const [a, b] = [await freshRole(world), await freshRole(world)];
        const first = await searchApplication(world, { roles: [a, b] });
        const second = await world.as(first.user).post(URL, applicationBody([b]));
        expectProblem('createSearchApplication', second, 409, 'APPLICATION_EXISTS');
        expect(await activeApplications(world, first.user.id)).toBe(1);
        const row = await applicationRow(world, first.application.id);
        expect(row.version).toBe(1);
      });

      it('FR-AUTH-05, FR-MATCH-03: no linked GitHub -> 409 GITHUB_REQUIRED and no application', async () => {
        const role = await freshRole(world);
        const user = await candidate(world, 'create-no-github', { roles: [role], github: false });
        expectProblem(
          'createSearchApplication',
          await world.as(user).post(URL, applicationBody([role])),
          409,
          'GITHUB_REQUIRED',
        );
        expect(await applicationsOf(world, user.id)).toEqual([]);
      });

      it('FR-WORK-08: the same Idempotency-Key replays the stored 201 without a second application', async () => {
        const role = await freshRole(world);
        const user = await candidate(world, 'create-replay', { roles: [role] });
        const key = randomUUID();
        const first = await world
          .as(user)
          .post(URL, applicationBody([role]), { idempotencyKey: key });
        const created = expectOk<SearchApplicationDto>('createSearchApplication', first, 201);
        const replay = await world
          .as(user)
          .post(URL, applicationBody([role]), { idempotencyKey: key });
        expect(replay.statusCode).toBe(201);
        expectReplayed(replay);
        expect(replay.json()).toEqual(created);
        expect(await applicationsOf(world, user.id)).toHaveLength(1);
      });

      it('FR-WORK-08: the same Idempotency-Key with another body -> 422 IDEMPOTENCY_KEY_REUSED', async () => {
        const [a, b] = [await freshRole(world), await freshRole(world)];
        const user = await candidate(world, 'create-key-reused', { roles: [a, b] });
        const key = randomUUID();
        expectOk(
          'createSearchApplication',
          await world.as(user).post(URL, applicationBody([a]), { idempotencyKey: key }),
          201,
        );
        expectProblem(
          'createSearchApplication',
          await world.as(user).post(URL, applicationBody([b]), { idempotencyKey: key }),
          422,
          'IDEMPOTENCY_KEY_REUSED',
        );
      });

      it('FR-WORK-08: a replayed 409 APPLICATION_EXISTS is the stored answer too', async () => {
        const role = await freshRole(world);
        const { user } = await searchApplication(world, { roles: [role] });
        const key = randomUUID();
        const first = await world
          .as(user)
          .post(URL, applicationBody([role]), { idempotencyKey: key });
        expectProblem('createSearchApplication', first, 409, 'APPLICATION_EXISTS');
        const replay = await world
          .as(user)
          .post(URL, applicationBody([role]), { idempotencyKey: key });
        expect(replay.statusCode).toBe(409);
        expectReplayed(replay);
        expect(replay.json<{ code: string }>().code).toBe('APPLICATION_EXISTS');
      });

      it('FR-WORK-08: a request without an Idempotency-Key -> 400 IDEMPOTENCY_KEY_MISSING', async () => {
        const role = await freshRole(world);
        const user = await candidate(world, 'create-no-key', { roles: [role] });
        const response = await world
          .as(user)
          .post(URL, applicationBody([role]), { idempotencyKey: null });
        expectProblem('createSearchApplication', response, 400, 'IDEMPOTENCY_KEY_MISSING');
      });
    });

    describe('updateSearchApplication', () => {
      it('FR-MATCH-04, FR-MATCH-06: new roles and priorities -> 200, version +1, enqueuedAt and the addedAt of a kept role stay, a new role gets addedAt = now', async () => {
        const [a, b, c] = [await freshRole(world), await freshRole(world), await freshRole(world)];
        const { user, application } = await searchApplication(world, {
          roles: [a, b],
          label: 'update-roles',
        });
        await world.ensureCatalog([c]);
        clock.advance(2 * 3_600_000);
        const updated = expectOk<SearchApplicationDto>(
          'updateSearchApplication',
          await world.as(user).put(URL, {
            roles: [
              { roleCode: b, priority: 1 },
              { roleCode: c, priority: 2 },
            ],
            version: application.version,
          }),
          200,
        );
        expect(updated.version).toBe(application.version + 1);
        expect(updated.id).toBe(application.id);
        expect(updated.status).toBe('active');
        expect(updated.enqueuedAt).toBe(application.enqueuedAt);
        const byRole = new Map(updated.roles.map((r) => [r.roleCode, r]));
        expect([...byRole.keys()].sort()).toEqual([b, c].sort());
        expect(byRole.get(b)?.priority).toBe(1);
        expect(byRole.get(c)?.priority).toBe(2);
        const keptBefore = application.roles.find((r) => r.roleCode === b);
        expect(byRole.get(b)?.addedAt).toBe(keptBefore?.addedAt);
        expect(Date.parse(byRole.get(c)?.addedAt ?? '')).toBeGreaterThan(
          Date.parse(application.enqueuedAt) + 3_600_000,
        );
        const stored = await applicationRoles(world, application.id);
        expect(stored.map((r) => r.role_code)).toEqual([b, c]);
      });

      it('FR-MATCH-04: two roles swap their priorities in one PUT (deferred unique constraint)', async () => {
        const [a, b] = [await freshRole(world), await freshRole(world)];
        const { user, application } = await searchApplication(world, {
          roles: [a, b],
          label: 'update-swap',
        });
        const swapped = expectOk<SearchApplicationDto>(
          'updateSearchApplication',
          await world.as(user).put(URL, {
            roles: [
              { roleCode: a, priority: 2 },
              { roleCode: b, priority: 1 },
            ],
            version: application.version,
          }),
          200,
        );
        expect(swapped.roles.find((r) => r.roleCode === a)?.priority).toBe(2);
        expect(swapped.roles.find((r) => r.roleCode === b)?.priority).toBe(1);
      });

      it('FR-MATCH-04: a stale version -> 409 VERSION_CONFLICT with the current application, nothing is overwritten', async () => {
        const [a, b] = [await freshRole(world), await freshRole(world)];
        const { user, application } = await searchApplication(world, {
          roles: [a, b],
          label: 'update-stale',
        });
        expectOk(
          'updateSearchApplication',
          await world.as(user).put(URL, {
            roles: [{ roleCode: a, priority: 1 }],
            version: application.version,
          }),
          200,
        );
        const stale = await world.as(user).put(URL, {
          roles: [{ roleCode: b, priority: 1 }],
          version: application.version,
        });
        const problem = expectProblem('updateSearchApplication', stale, 409, 'VERSION_CONFLICT');
        expect(problem.current).toMatchObject({ id: application.id, version: 2 });
        const stored = await applicationRoles(world, application.id);
        expect(stored.map((r) => r.role_code)).toEqual([a]);
      });

      it('FR-MATCH-04: no version -> 400 (VERSION_MISSING or VALIDATION_FAILED)', async () => {
        const role = await freshRole(world);
        const { user } = await searchApplication(world, { roles: [role], label: 'update-nover' });
        const response = await world
          .as(user)
          .put(URL, { roles: [{ roleCode: role, priority: 1 }] });
        expect(response.statusCode, response.body).toBe(400);
        expect(['VERSION_MISSING', 'VALIDATION_FAILED']).toContain(
          response.json<{ code: string }>().code,
        );
      });

      it('FR-MATCH-04: a repeated priority or a role outside the catalog -> 422, nothing changes', async () => {
        const [a, b] = [await freshRole(world), await freshRole(world)];
        const { user, application } = await searchApplication(world, {
          roles: [a, b],
          label: 'update-422',
        });
        const dup = await world.as(user).put(URL, {
          roles: [
            { roleCode: a, priority: 1 },
            { roleCode: b, priority: 1 },
          ],
          version: application.version,
        });
        expectCode(dup, 422);
        const unknown = await world.as(user).put(URL, {
          roles: [{ roleCode: 'no_such_role', priority: 1 }],
          version: application.version,
        });
        expectCode(unknown, 422);
        expect((await applicationRow(world, application.id)).version).toBe(application.version);
      });

      it('FR-MATCH-04: no active application -> 404 APPLICATION_NOT_FOUND', async () => {
        const role = await freshRole(world);
        const user = await candidate(world, 'update-none', { roles: [role] });
        expectProblem(
          'updateSearchApplication',
          await world.as(user).put(URL, { roles: [{ roleCode: role, priority: 1 }], version: 1 }),
          404,
          'APPLICATION_NOT_FOUND',
        );
      });

      it('FR-WORK-08: the same Idempotency-Key replays the stored 200; the version moved once', async () => {
        const [a, b] = [await freshRole(world), await freshRole(world)];
        const { user, application } = await searchApplication(world, {
          roles: [a, b],
          label: 'update-replay',
        });
        const key = randomUUID();
        const body = { roles: [{ roleCode: b, priority: 1 }], version: application.version };
        const first = await world.as(user).put(URL, body, { idempotencyKey: key });
        const updated = expectOk<SearchApplicationDto>('updateSearchApplication', first, 200);
        const replay = await world.as(user).put(URL, body, { idempotencyKey: key });
        expect(replay.statusCode).toBe(200);
        expectReplayed(replay);
        expect(replay.json()).toEqual(updated);
        expect((await applicationRow(world, application.id)).version).toBe(updated.version);
      });
    });

    describe('cancelSearchApplication', () => {
      it('FR-MATCH-04: -> 204, no active application any more, the row is cancelled and keeps its history', async () => {
        const role = await freshRole(world);
        const { user, application } = await searchApplication(world, {
          roles: [role],
          label: 'cancel',
        });
        const response = await world.as(user).delete(URL);
        expectOk('cancelSearchApplication', response, 204);
        expectProblem(
          'getMySearchApplication',
          await world.as(user).get(URL),
          404,
          'APPLICATION_NOT_FOUND',
        );
        const row = await applicationRow(world, application.id);
        expect(row.status).toBe('cancelled');
        expect(row.cancelled_at).not.toBeNull();
        expect((await applicationRoles(world, application.id)).every((r) => !r.is_active)).toBe(
          true,
        );
      });

      it('FR-MATCH-04: after cancelling, a new application starts a new wait: enqueuedAt is not kept', async () => {
        const role = await freshRole(world);
        const { user, application } = await searchApplication(world, {
          roles: [role],
          label: 'cancel-resubmit',
        });
        expectOk('cancelSearchApplication', await world.as(user).delete(URL), 204);
        clock.advance(DAY);
        const again = expectOk<SearchApplicationDto>(
          'createSearchApplication',
          await world.as(user).post(URL, applicationBody([role])),
          201,
        );
        expect(again.id).not.toBe(application.id);
        expect(Date.parse(again.enqueuedAt)).toBeGreaterThanOrEqual(
          Date.parse(application.enqueuedAt) + DAY - 1000,
        );
        expect(await activeApplications(world, user.id)).toBe(1);
      });

      it('FR-MATCH-04: nothing to cancel -> 404 APPLICATION_NOT_FOUND', async () => {
        const user = await candidate(world, 'cancel-none', { roles: [] });
        expectProblem(
          'cancelSearchApplication',
          await world.as(user).delete(URL),
          404,
          'APPLICATION_NOT_FOUND',
        );
      });

      it('FR-WORK-08: the same Idempotency-Key replays the stored 204; a second cancel with a new key is 404', async () => {
        const role = await freshRole(world);
        const { user } = await searchApplication(world, { roles: [role], label: 'cancel-replay' });
        const key = randomUUID();
        expect((await world.as(user).delete(URL, { idempotencyKey: key })).statusCode).toBe(204);
        const replay = await world.as(user).delete(URL, { idempotencyKey: key });
        expect(replay.statusCode).toBe(204);
        expectReplayed(replay);
        expectProblem(
          'cancelSearchApplication',
          await world.as(user).delete(URL),
          404,
          'APPLICATION_NOT_FOUND',
        );
      });
    });

    describe('one application per person', () => {
      it('FR-MATCH-03: at most one active application survives any sequence of create / cancel / create', async () => {
        const role = await freshRole(world);
        const user = await candidate(world, 'sequence', { roles: [role] });
        const caller = world.as(user);
        expectOk('createSearchApplication', await caller.post(URL, applicationBody([role])), 201);
        expectOk('cancelSearchApplication', await caller.delete(URL), 204);
        expectOk('createSearchApplication', await caller.post(URL, applicationBody([role])), 201);
        expect(await activeApplications(world, user.id)).toBe(1);
        expect(await applicationsOf(world, user.id)).toHaveLength(2);
      });
    });

    describe('contract shape', () => {
      it('FR-MATCH-03: the application of one person is not readable through another account', async () => {
        const role = await freshRole(world);
        const mine = await searchApplication(world, { roles: [role], label: 'shape-mine' });
        const other = await candidate(world, 'shape-other', { roles: [role] });
        expectProblem(
          'getMySearchApplication',
          await world.as(other).get(URL),
          404,
          'APPLICATION_NOT_FOUND',
        );
        const stillMine = await world.as(mine.user).get(URL);
        expect(stillMine.statusCode).toBe(200);
      });
    });
  },
);
