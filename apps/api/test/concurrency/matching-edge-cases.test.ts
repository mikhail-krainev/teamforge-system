import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { fireAll } from '../fixtures/concurrency.js';
import {
  activeApplications,
  applicationRow,
  applicationRoles,
  fulfilledApplications,
  waitSamples,
} from '../fixtures/matching-db.js';
import {
  candidate,
  freshRole,
  runAutoAdd,
  searchApplication,
  startExtraWorkers,
  teamWithDemand,
  waitFulfilled,
  type SearchApplicationFixture,
} from '../fixtures/matching.js';
import {
  activeAssignments,
  activeMembershipsOf,
  expectNoDeadlocks,
  seatStatus,
} from '../fixtures/teams-db.js';
import { World } from '../fixtures/world.js';
import { describeInfra, waitFor } from '../helpers/infra.js';

/*
 * S4-09, edge cases of the auto-add under concurrency (docs/plan.md S4-09, architecture 12.5 CC-3,
 * CC-10): the seat is closed while a run is adding, two runs overlap while the application changes,
 * 20 people fight for few seats. The world has no worker of its own; two extra workers make two
 * `runAutoAdd()` jobs overlap for real. Every round uses its own role codes (`freshRole`).
 */

const URL = '/v1/me/search-application';
const ROUNDS = 20;

vi.setConfig({ testTimeout: 240_000 });

describeInfra('S4-09: auto-add edge cases under concurrency', ['db', 'redis'], () => {
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

  it('the seat is closed while a run adds into it (20 rounds): the add or the close wins, never both - a closed seat has no member, a filled seat is not closed', async () => {
    const outcomes = { closed: 0, filled: 0 };
    for (let round = 0; round < ROUNDS; round += 1) {
      const role = await freshRole(world);
      const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
      const seatId = f.openSeats[0]?.id ?? '';
      const queued = await searchApplication(world, { roles: [role], label: `close-${round}` });

      const [closing] = await Promise.all([
        fireAll(1, (_i, key) =>
          world.as(f.lead).delete(`/v1/teams/${f.id}/seats/${seatId}`, { idempotencyKey: key }),
        ),
        runAutoAdd(world, 1),
      ]);
      const status = closing[0]?.status ?? 0;
      expect(status, `round ${round}`).toBeLessThan(500);
      // a run that started later must not change the verdict
      await runAutoAdd(world, 1);

      const seat = await seatStatus(world, seatId);
      const row = await applicationRow(world, queued.application.id);
      if (status === 204) {
        outcomes.closed += 1;
        expect(seat, `round ${round}`).toBe('closed');
        expect(await activeAssignments(world, seatId), `round ${round}`).toBe(0);
        expect(row.status, `round ${round}`).toBe('active');
        expect(await activeMembershipsOf(world, queued.user.id), `round ${round}`).toBe(0);
        expect(await waitSamples(world, queued.application.id)).toEqual([]);
      } else {
        outcomes.filled += 1;
        expect([404, 409, 422], `round ${round}: close answered ${status}`).toContain(status);
        expect(seat, `round ${round}`).toBe('filled');
        expect(await activeAssignments(world, seatId), `round ${round}`).toBe(1);
        expect(row, `round ${round}`).toMatchObject({
          status: 'fulfilled',
          fulfilled_seat_id: seatId,
        });
        expect(await activeMembershipsOf(world, queued.user.id), `round ${round}`).toBe(1);
        expect(await waitSamples(world, queued.application.id)).toHaveLength(1);
      }
    }
    expect(outcomes.closed + outcomes.filled).toBe(ROUNDS);
  });

  it('two parallel runs while the application changes (20 rounds): added exactly once, into a seat of a role the application had at that moment, the other seat stays open', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const [a, b] = [await freshRole(world), await freshRole(world)];
      const teamA = await teamWithDemand(world, { roleCode: a, openSeats: 1 });
      const teamB = await teamWithDemand(world, { roleCode: b, openSeats: 1 });
      const seatA = teamA.openSeats[0]?.id ?? '';
      const seatB = teamB.openSeats[0]?.id ?? '';
      // the person has both roles in the profile; the application starts with A only
      const person = await candidate(world, `change-${round}`, { roles: [a, b] });
      const queued = await searchApplication(world, { roles: [a], user: person });
      // even rounds drop A for B; odd rounds keep A and put B first
      const dropsA = round % 2 === 0;
      const roles = dropsA
        ? [{ roleCode: b, priority: 1 }]
        : [
            { roleCode: b, priority: 1 },
            { roleCode: a, priority: 2 },
          ];

      const [update] = await Promise.all([
        fireAll(1, (_i, key) =>
          world
            .as(queued.user)
            .put(URL, { roles, version: queued.application.version }, { idempotencyKey: key }),
        ),
        runAutoAdd(world, 2),
      ]);
      const status = update[0]?.status ?? 0;
      expect([200, 404], `round ${round}: update answered ${status}`).toContain(status);
      // runs that read the application before the change get one more chance
      await runAutoAdd(world, 2);
      await waitFulfilled(world, queued.application.id);

      const row = await applicationRow(world, queued.application.id);
      const filledA = (await seatStatus(world, seatA)) === 'filled';
      const filledB = (await seatStatus(world, seatB)) === 'filled';
      expect(filledA !== filledB, `round ${round}: exactly one seat is filled`).toBe(true);
      expect(await activeMembershipsOf(world, queued.user.id), `round ${round}`).toBe(1);
      expect(await fulfilledApplications(world, queued.user.id), `round ${round}`).toBe(1);
      expect(await activeApplications(world, queued.user.id), `round ${round}`).toBe(0);
      expect(await waitSamples(world, queued.application.id), `round ${round}`).toHaveLength(1);
      expect(await activeAssignments(world, filledA ? seatA : seatB)).toBe(1);
      expect(row).toMatchObject(
        filledA
          ? { fulfilled_role_code: a, fulfilled_team_id: teamA.id, fulfilled_seat_id: seatA }
          : { fulfilled_role_code: b, fulfilled_team_id: teamB.id, fulfilled_seat_id: seatB },
      );
      if (status === 404) {
        // the add came first: the late change was refused and did not touch the application
        expect(filledA, `round ${round}: the add won, so it was the old role`).toBe(true);
        expect((await applicationRoles(world, queued.application.id)).map((r) => r.role_code)).toEqual(
          [a],
        );
      } else if (dropsA) {
        // the change came first and A is gone: only B can have been used
        expect(filledB, `round ${round}: A was dropped before the add`).toBe(true);
      }
    }
  });

  it('20 people, 3 seats, 3 overlapping runs: the three who wait longest get the seats, the other 17 stay active without a wait sample', async () => {
    const role = await freshRole(world);
    const line: SearchApplicationFixture[] = [];
    for (let i = 0; i < 20; i += 1) {
      line.push(await searchApplication(world, { roles: [role], label: `line-${i}` }));
    }
    const teams = [];
    for (let i = 0; i < 3; i += 1) teams.push(await teamWithDemand(world, { roleCode: role, openSeats: 1 }));
    await runAutoAdd(world, 3);
    await waitFor(async () => {
      const rows = await Promise.all(line.map((l) => applicationRow(world, l.application.id)));
      return rows.filter((r) => r.status === 'fulfilled').length === 3;
    }, 30_000);
    // later runs find nothing more to do
    await runAutoAdd(world, 2);

    const rows = await Promise.all(line.map((l) => applicationRow(world, l.application.id)));
    expect(rows.map((r, i) => [i, r.status])).toEqual(
      line.map((_l, i) => [i, i < 3 ? 'fulfilled' : 'active']),
    );
    for (const team of teams) expect(await activeAssignments(world, team.openSeats[0]?.id ?? '')).toBe(1);
    expect(new Set(rows.slice(0, 3).map((r) => r.fulfilled_team_id)).size).toBe(3);
    for (const entry of line.slice(0, 3)) {
      expect(await activeMembershipsOf(world, entry.user.id)).toBe(1);
      expect(await waitSamples(world, entry.application.id)).toHaveLength(1);
    }
    for (const entry of line.slice(3)) {
      expect(await activeMembershipsOf(world, entry.user.id)).toBe(0);
      expect(await waitSamples(world, entry.application.id)).toEqual([]);
    }
  });
});
