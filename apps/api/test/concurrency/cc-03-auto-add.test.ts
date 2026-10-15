import { afterAll, beforeAll, expect, it } from 'vitest';
import { codesAt, expectReplayOf, fireAll, tally } from '../fixtures/concurrency.js';
import {
  activeApplications,
  applicationRow,
  fulfilledApplications,
  waitSamples,
} from '../fixtures/matching-db.js';
import {
  candidate,
  freshRole,
  runAutoAdd,
  searchApplication,
  startExtraWorkers,
  type SearchApplicationFixture,
  teamWithDemand,
  waitFulfilled,
} from '../fixtures/matching.js';
import { expectOk, team } from '../fixtures/teams.js';
import {
  activeAssignments,
  activeMembershipsOf,
  expectNoDeadlocks,
  seatStatus,
} from '../fixtures/teams-db.js';
import { World } from '../fixtures/world.js';
import { describeInfra, waitFor } from '../helpers/infra.js';

/*
 * CC-3 (docs/architecture.md 12.5): `matching-auto-add`, locks #1 user -> #2 application -> #4 team
 * -> #5 seat, `search_application_active_uq`, `seat_assignment_active_seat_uq`, `membership_active_uq`.
 * The world has no worker of its own; two extra workers (one job at a time each) make two
 * `runAutoAdd()` jobs truly overlap. Run with `--repeat 5` (plan, S4 criteria).
 */
describeInfra('CC-3: auto-add from the queue (FR-MATCH-05, FR-MATCH-07)', ['db', 'redis'], () => {
  let world: World;
  let workers: { close(): Promise<void> };
  let deadlocksBefore = 0;

  beforeAll(async () => {
    world = await World.start({ worker: false });
    await world.ensureCatalog(['backend', 'frontend', 'pm', 'designer', 'qa', 'devops']);
    workers = await startExtraWorkers(world, 2);
    deadlocksBefore = await world.deadlocks();
  });

  afterAll(async () => {
    if (!world) return;
    await workers.close();
    await expectNoDeadlocks(world, deadlocksBefore);
    await world.close();
  });

  it('CC-3(а): two runAutoAdd() at once, 1 application and 3 fitting seats -> added once, fulfilled once, 1 wait sample', async () => {
    for (let round = 0; round < 3; round += 1) {
      const role = await freshRole(world);
      const queued = await searchApplication(world, { roles: [role], label: `cc3a-${round}` });
      const teams = [
        await teamWithDemand(world, { roleCode: role, openSeats: 1 }),
        await teamWithDemand(world, { roleCode: role, openSeats: 1 }),
        await teamWithDemand(world, { roleCode: role, openSeats: 1 }),
      ];
      await runAutoAdd(world, 2);
      await waitFulfilled(world, queued.application.id);
      expect(await activeMembershipsOf(world, queued.user.id)).toBe(1);
      expect(await fulfilledApplications(world, queued.user.id)).toBe(1);
      expect(await activeApplications(world, queued.user.id)).toBe(0);
      expect(await waitSamples(world, queued.application.id)).toHaveLength(1);
      const statuses = await Promise.all(
        teams.map((t) => seatStatus(world, t.openSeats[0]?.id ?? '')),
      );
      expect(statuses.filter((s) => s === 'filled')).toHaveLength(1);
      expect(statuses.filter((s) => s === 'open')).toHaveLength(2);
    }
  });

  it('CC-3(б): 20 applications, 1 seat, 2 parallel runs -> exactly one assignment, 19 stay active, the longest waiting wins', async () => {
    const role = await freshRole(world);
    const applications: SearchApplicationFixture[] = [];
    for (let i = 0; i < 20; i += 1) {
      applications.push(await searchApplication(world, { roles: [role], label: `cc3b-${i}` }));
    }
    const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
    const seatId = f.openSeats[0]?.id ?? '';
    await runAutoAdd(world, 2);
    const first = applications[0];
    if (!first) throw new Error('no application');
    await waitFulfilled(world, first.application.id);
    expect(await activeAssignments(world, seatId)).toBe(1);
    const rows = await Promise.all(
      applications.map((a) => applicationRow(world, a.application.id)),
    );
    expect(rows.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(19);
    expect(rows[0]?.status).toBe('fulfilled');
    expect(rows[0]?.fulfilled_seat_id).toBe(seatId);
    for (const a of applications.slice(1)) {
      expect(await waitSamples(world, a.application.id)).toEqual([]);
    }
  });

  it('CC-3(б): three parallel runs and two seats -> two assignments, no seat twice, each person at most once', async () => {
    const role = await freshRole(world);
    const applications: SearchApplicationFixture[] = [];
    for (let i = 0; i < 6; i += 1) {
      applications.push(await searchApplication(world, { roles: [role], label: `cc3b2-${i}` }));
    }
    const f = await teamWithDemand(world, { roleCode: role, openSeats: 2 });
    await runAutoAdd(world, 2);
    await runAutoAdd(world, 2);
    await waitFor(async () => {
      const rows = await Promise.all(
        applications.map((a) => applicationRow(world, a.application.id)),
      );
      return rows.filter((r) => r.status === 'fulfilled').length === 2;
    }, 30_000);
    for (const seat of f.openSeats) expect(await activeAssignments(world, seat.id)).toBe(1);
    for (const a of applications)
      expect(await activeMembershipsOf(world, a.user.id)).toBeLessThanOrEqual(1);
  });

  it('CC-3(в): auto-add and a manual acceptSeatOffer of the same person at one free slot of C-10 -> exactly one succeeds', async () => {
    for (let round = 0; round < 4; round += 1) {
      const role = await freshRole(world);
      const person = await candidate(world, `cc3c-${round}`, { roles: [role] });
      const base = await team(world, { openSeats: 1 });
      const baseSeat = base.openSeats[0];
      if (!baseSeat) throw new Error('no seat');
      const baseOffer = expectOk<{ id: string }>(
        'createSeatOffer',
        await world
          .as(base.lead)
          .post(`/v1/teams/${base.id}/seat-offers`, { seatId: baseSeat.id, userId: person.id }),
        201,
      );
      expectOk(
        'acceptSeatOffer',
        await world.as(person).post(`/v1/seat-offers/${baseOffer.id}/acceptance`),
        200,
      );

      const queued = await searchApplication(world, { roles: [role], user: person });
      const auto = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
      const manual = await team(world, { openSeats: 1 });
      const manualSeat = manual.openSeats[0];
      if (!manualSeat) throw new Error('no seat');
      const offer = expectOk<{ id: string }>(
        'createSeatOffer',
        await world
          .as(manual.lead)
          .post(`/v1/teams/${manual.id}/seat-offers`, { seatId: manualSeat.id, userId: person.id }),
        201,
      );

      const [fired] = await Promise.all([
        fireAll(1, (_i, key) =>
          world
            .as(person)
            .post(`/v1/seat-offers/${offer.id}/acceptance`, undefined, { idempotencyKey: key }),
        ),
        runAutoAdd(world, 1),
      ]);
      await waitFor(async () => (await activeMembershipsOf(world, person.id)) === 2, 30_000);
      expect(await activeMembershipsOf(world, person.id)).toBe(2);

      const accept = fired[0];
      if (!accept) throw new Error('no response');
      const joinedAuto =
        (await applicationRow(world, queued.application.id)).status === 'fulfilled';
      if (accept.status === 200) {
        // the manual join took the last slot: the auto-add was refused and the person still waits
        expect(joinedAuto).toBe(false);
        expect(await seatStatus(world, auto.openSeats[0]?.id ?? '')).toBe('open');
        expect(await activeApplications(world, person.id)).toBe(1);
      } else {
        expect(accept.status).toBe(409);
        expect(codesAt(fired, 409)).toEqual(['PROJECT_LIMIT']);
        expect(joinedAuto).toBe(true);
        expect(await seatStatus(world, manualSeat.id)).toBe('open');
      }
      const replay = await world
        .as(person)
        .post(`/v1/seat-offers/${offer.id}/acceptance`, undefined, { idempotencyKey: accept.key });
      expectReplayOf(accept, replay);
      expect(tally(fired)[accept.status]).toBe(1);
    }
  });
});
