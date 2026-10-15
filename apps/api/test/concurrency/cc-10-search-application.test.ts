import { afterAll, beforeAll, expect, it } from 'vitest';
import { codesAt, expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import {
  activeApplications,
  applicationRoles,
  applicationRow,
  applicationsOf,
} from '../fixtures/matching-db.js';
import {
  applicationBody,
  candidate,
  freshRole,
  readTeam,
  runAutoAdd,
  searchApplication,
  teamWithDemand,
  type SearchApplicationDto,
} from '../fixtures/matching.js';
import { activeMembershipsOf, expectNoDeadlocks, seatStatus } from '../fixtures/teams-db.js';
import { World } from '../fixtures/world.js';
import { describeInfra, waitFor } from '../helpers/infra.js';

const URL = '/v1/me/search-application';

/*
 * CC-10 (docs/architecture.md 12.5): creation is guarded by `search_application_active_uq`
 * (23505 -> 409 APPLICATION_EXISTS); change and cancel take lock #1 (user) -> #2 (application
 * FOR UPDATE) and check `version`. Run with `--repeat 5`.
 */
describeInfra('CC-10: the search application (FR-MATCH-03, FR-MATCH-04)', ['db', 'redis'], () => {
  let world: World;
  let deadlocksBefore = 0;

  beforeAll(async () => {
    world = await World.start();
    await world.ensureCatalog(['backend', 'frontend', 'pm', 'designer', 'qa', 'devops']);
    deadlocksBefore = await world.deadlocks();
  });

  afterAll(async () => {
    if (!world) return;
    await expectNoDeadlocks(world, deadlocksBefore);
    await world.close();
  });

  it('CC-10(а): 10 createSearchApplication in parallel -> 1 x 201, 9 x 409 APPLICATION_EXISTS, one active application', async () => {
    const role = await freshRole(world);
    const user = await candidate(world, 'cc10-create', { roles: [role] });
    const fired = await fireAll(10, (_i, key) =>
      world.as(user).post(URL, applicationBody([role]), { idempotencyKey: key }),
    );
    expect(tally(fired)).toEqual({ 201: 1, 409: 9 });
    expect(codesAt(fired, 409)).toEqual(['APPLICATION_EXISTS']);
    expect(await activeApplications(world, user.id)).toBe(1);
    expect(await applicationsOf(world, user.id)).toHaveLength(1);
    const winner = winnerOf(fired, 201);
    expect(
      (await applicationRoles(world, winner.response.json<SearchApplicationDto>().id)).length,
    ).toBe(1);
    // the replay pair of the winner and of a loser
    expectReplayOf(
      winner,
      await world.as(user).post(URL, applicationBody([role]), { idempotencyKey: winner.key }),
    );
    const loser = winnerOf(fired, 409);
    expectReplayOf(
      loser,
      await world.as(user).post(URL, applicationBody([role]), { idempotencyKey: loser.key }),
    );
    expect(await activeApplications(world, user.id)).toBe(1);
  });

  it('CC-10(а): 10 parallel creates with ONE Idempotency-Key -> one application, no 5xx', async () => {
    const role = await freshRole(world);
    const user = await candidate(world, 'cc10-create-key', { roles: [role] });
    const key = 'f3a2a8f0-0c1e-4f4e-9d52-7a2d6b0a9c10';
    const fired = await fireAll(
      10,
      (_i, k) => world.as(user).post(URL, applicationBody([role]), { idempotencyKey: k }),
      Array.from({ length: 10 }, () => key),
    );
    expect(fired.every((f) => f.status < 500)).toBe(true);
    expect(fired.filter((f) => f.status === 201).length).toBeGreaterThanOrEqual(1);
    // the others are the stored 201 (replay) or the in-progress marker
    for (const f of fired.filter((x) => x.status !== 201)) {
      expect(f.status).toBe(409);
      expect(f.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    }
    expect(await applicationsOf(world, user.id)).toHaveLength(1);
  });

  it("CC-10(б): 10 updateSearchApplication with the same version -> 1 x 200, 9 x 409 VERSION_CONFLICT, the stored roles are the winner's", async () => {
    const roles = [
      await freshRole(world),
      await freshRole(world),
      await freshRole(world),
      await freshRole(world),
    ];
    const { user, application } = await searchApplication(world, {
      roles: [roles[0] as string],
      label: 'cc10-update',
    });
    await world.ensureCatalog(roles);
    const fired = await fireAll(10, (i, key) =>
      world.as(user).put(
        URL,
        {
          roles: [{ roleCode: roles[(i % 3) + 1], priority: 1 }],
          version: application.version,
        },
        { idempotencyKey: key },
      ),
    );
    expect(tally(fired)).toEqual({ 200: 1, 409: 9 });
    expect(codesAt(fired, 409)).toEqual(['VERSION_CONFLICT']);
    const winner = winnerOf(fired, 200);
    const stored = (await applicationRoles(world, application.id)).map((r) => r.role_code);
    expect(stored).toEqual([roles[(winner.index % 3) + 1]]);
    expect((await applicationRow(world, application.id)).version).toBe(application.version + 1);
    expectReplayOf(
      winner,
      await world.as(user).put(
        URL,
        {
          roles: [{ roleCode: roles[(winner.index % 3) + 1], priority: 1 }],
          version: application.version,
        },
        { idempotencyKey: winner.key },
      ),
    );
    expect((await applicationRow(world, application.id)).version).toBe(application.version + 1);
  });

  it('CC-10(б): update and cancel at the same moment -> either the update, then the cancel, or the cancel, then a 404 for the update', async () => {
    for (let round = 0; round < 3; round += 1) {
      const [a, b] = [await freshRole(world), await freshRole(world)];
      const { user, application } = await searchApplication(world, {
        roles: [a],
        label: `cc10-upd-cancel-${round}`,
      });
      const [update, cancel] = await Promise.all([
        fireAll(1, (_i, key) =>
          world
            .as(user)
            .put(
              URL,
              { roles: [{ roleCode: b, priority: 1 }], version: application.version },
              { idempotencyKey: key },
            ),
        ),
        fireAll(1, (_i, key) => world.as(user).delete(URL, { idempotencyKey: key })),
      ]);
      expect(cancel[0]?.status).toBe(204);
      expect([200, 404]).toContain(update[0]?.status);
      if (update[0]?.status === 404) expect(update[0].code).toBe('APPLICATION_NOT_FOUND');
      expect((await applicationRow(world, application.id)).status).toBe('cancelled');
      expect(await activeApplications(world, user.id)).toBe(0);
    }
  });

  it('CC-10(б): 5 parallel cancels -> 1 x 204, 4 x 404 APPLICATION_NOT_FOUND', async () => {
    const role = await freshRole(world);
    const { user, application } = await searchApplication(world, {
      roles: [role],
      label: 'cc10-cancel',
    });
    const fired = await fireAll(5, (_i, key) =>
      world.as(user).delete(URL, { idempotencyKey: key }),
    );
    expect(tally(fired)).toEqual({ 204: 1, 404: 4 });
    expect(codesAt(fired, 404)).toEqual(['APPLICATION_NOT_FOUND']);
    expect((await applicationRow(world, application.id)).status).toBe('cancelled');
    expectReplayOf(
      winnerOf(fired, 204),
      await world.as(user).delete(URL, { idempotencyKey: winnerOf(fired, 204).key }),
    );
  });

  it('CC-10(в): update that drops the role at the same moment as the auto-add -> either the change before the add (nobody is added) or a refusal after the add', async () => {
    for (let round = 0; round < 5; round += 1) {
      const [wanted, other] = [await freshRole(world), await freshRole(world)];
      const { user, application } = await searchApplication(world, {
        roles: [wanted],
        label: `cc10-vs-auto-${round}`,
      });
      await world.ensureCatalog([other]);
      const f = await teamWithDemand(world, { roleCode: wanted, openSeats: 1 });
      const seatId = f.openSeats[0]?.id ?? '';
      const [update] = await Promise.all([
        fireAll(1, (_i, key) =>
          world
            .as(user)
            .put(
              URL,
              { roles: [{ roleCode: other, priority: 1 }], version: application.version },
              { idempotencyKey: key },
            ),
        ),
        runAutoAdd(world, 1),
      ]);
      const status = update[0]?.status ?? 0;
      // settle: a late background run must not change the verdict
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const row = await applicationRow(world, application.id);
      if (status === 200) {
        expect(row.status).toBe('active');
        expect(await seatStatus(world, seatId)).toBe('open');
        expect(await activeMembershipsOf(world, user.id)).toBe(0);
        expect((await applicationRoles(world, application.id)).map((r) => r.role_code)).toEqual([
          other,
        ]);
      } else {
        expect([404, 409]).toContain(status);
        expect(row.status).toBe('fulfilled');
        expect(await seatStatus(world, seatId)).toBe('filled');
        expect(await activeMembershipsOf(world, user.id)).toBe(1);
        const dto = await readTeam(world, f.lead, f.id);
        expect(dto.members.some((m) => m.userId === user.id && m.joinedVia === 'auto')).toBe(true);
      }
    }
  });

  it('CC-10(в): update that keeps the role at the same moment as the auto-add -> the person is added exactly once in every order', async () => {
    for (let round = 0; round < 3; round += 1) {
      const [wanted, extra] = [await freshRole(world), await freshRole(world)];
      const { user, application } = await searchApplication(world, {
        roles: [wanted],
        label: `cc10-keep-${round}`,
      });
      await world.ensureCatalog([extra]);
      const f = await teamWithDemand(world, { roleCode: wanted, openSeats: 1 });
      const [update] = await Promise.all([
        fireAll(1, (_i, key) =>
          world.as(user).put(
            URL,
            {
              roles: [
                { roleCode: wanted, priority: 1 },
                { roleCode: extra, priority: 2 },
              ],
              version: application.version,
            },
            { idempotencyKey: key },
          ),
        ),
        runAutoAdd(world, 1),
      ]);
      expect([200, 404, 409]).toContain(update[0]?.status);
      await waitFor(
        async () => (await applicationRow(world, application.id)).status === 'fulfilled',
        30_000,
      );
      expect(await activeMembershipsOf(world, user.id)).toBe(1);
      expect(await seatStatus(world, f.openSeats[0]?.id ?? '')).toBe('filled');
    }
  });
});
