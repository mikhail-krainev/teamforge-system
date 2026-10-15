import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import {
  assignmentDeficit,
  applicationRoles,
  waitSamples,
} from '../../../../test/fixtures/matching-db.js';
import {
  applicationBody,
  candidate,
  freshRole,
  searchApplication,
  teamWithDemand,
  type RoleDemandDto,
} from '../../../../test/fixtures/matching.js';
import {
  expectOk,
  joinThroughOffer,
  team,
  type OfferDto,
} from '../../../../test/fixtures/teams.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

const DAY_MS = 24 * 3_600_000;

describeInfra(
  'S4 matching: demand showcase and deficit (FR-MATCH-09, -10, -11, FR-PROF-07, FR-TEAM-25)',
  ['db', 'redis'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());

    beforeAll(async () => {
      // No worker: the queue must stay exactly as built and the Redis cache is read once per role.
      world = await startWorld({ clock, worker: false });
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    const demandOf = async (viewer: UserFixture, roles: string[]): Promise<RoleDemandDto[]> =>
      expectOk<{ items: RoleDemandDto[] }>(
        'getRoleDemand',
        await world.as(viewer).get(`/v1/demand?${roles.map((r) => `roles=${r}`).join('&')}`),
        200,
      ).items;

    const insertSamples = async (
      roleCode: string,
      waits: number[],
      matchedAt: Date = clock.now(),
    ): Promise<void> => {
      for (const waited of waits) {
        await world.sql`
          INSERT INTO matching.wait_sample (id, application_id, role_code, waited_seconds, matched_at)
          VALUES (${randomUUID()}, ${randomUUID()}, ${roleCode}, ${waited}, ${matchedAt})`;
      }
    };

    describe('getRoleDemand', () => {
      it('FR-MATCH-09: open seats, teams seeking and the queue of a role (200, contract schema)', async () => {
        const role = await freshRole(world);
        const a = await teamWithDemand(world, { roleCode: role, openSeats: 2, queued: 3 });
        await team(world, { roleCode: role, openSeats: 1 });
        const viewer = await candidate(world, 'demand-viewer', { roles: [role] });
        const [item, ...rest] = await demandOf(viewer, [role]);
        expect(rest).toEqual([]);
        expect(item).toMatchObject({
          roleCode: role,
          teamsSeeking: 2,
          openSeats: 3,
          queuedCandidates: 3,
          avgWaitSeconds: null,
          avgWaitStatus: 'insufficient_data',
        });
        expect(Date.parse(item?.computedAt ?? '')).not.toBeNaN();
        expect(a.queuedApplications).toHaveLength(3);
      });

      it('FR-MATCH-09: a team of 8 and a team that is not forming/active are not seeking (C-02, statuses)', async () => {
        const role = await freshRole(world);
        await team(world, { roleCode: role, openSeats: 1 });
        const full = await team(world, { members: 8, roleCode: role, openSeats: 1 });
        expect(full.dto.memberCount).toBe(8);
        const viewer = await candidate(world, 'demand-full-viewer', { roles: [] });
        const [item] = await demandOf(viewer, [role]);
        expect(item).toMatchObject({ teamsSeeking: 1, openSeats: 1 });
      });

      it('FR-MATCH-11: the role is a deficit when open seats are strictly more than the queue; equal is not', async () => {
        const [more, equal, fewer] = [
          await freshRole(world),
          await freshRole(world),
          await freshRole(world),
        ];
        await teamWithDemand(world, { roleCode: more, openSeats: 3, queued: 1 });
        await teamWithDemand(world, { roleCode: equal, openSeats: 2, queued: 2 });
        await teamWithDemand(world, { roleCode: fewer, openSeats: 1, queued: 2 });
        const viewer = await candidate(world, 'demand-deficit-viewer', { roles: [] });
        const items = await demandOf(viewer, [more, equal, fewer]);
        const by = new Map(items.map((i) => [i.roleCode, i]));
        expect(by.get(more)?.deficit).toBe(true);
        expect(by.get(equal)?.deficit).toBe(false);
        expect(by.get(fewer)?.deficit).toBe(false);
      });

      it('FR-MATCH-09: without `roles` the answer is about the desired roles of the profile (FR-PROF-07)', async () => {
        const [a, b] = [await freshRole(world), await freshRole(world)];
        await teamWithDemand(world, { roleCode: a, openSeats: 1 });
        const viewer = await candidate(world, 'demand-default-roles', { roles: [a, b] });
        const items = expectOk<{ items: RoleDemandDto[] }>(
          'getRoleDemand',
          await world.as(viewer).get('/v1/demand'),
          200,
        ).items;
        expect(items.map((i) => i.roleCode).sort()).toEqual([a, b].sort());
        expect(items.find((i) => i.roleCode === a)?.openSeats).toBe(1);
      });

      it('FR-MATCH-09: 21 roles or a malformed role key -> 400 VALIDATION_FAILED', async () => {
        const viewer = await candidate(world, 'demand-bad-query', { roles: [] });
        const many = Array.from({ length: 21 }, (_, i) => `role_${i}`)
          .map((r) => `roles=${r}`)
          .join('&');
        expectProblem(
          'getRoleDemand',
          await world.as(viewer).get(`/v1/demand?${many}`),
          400,
          'VALIDATION_FAILED',
        );
        expectProblem(
          'getRoleDemand',
          await world.as(viewer).get('/v1/demand?roles=NOT%20A%20ROLE'),
          400,
          'VALIDATION_FAILED',
        );
      });

      it('FR-MATCH-09: the answer is cached (C-39): a second read returns the same computedAt', async () => {
        const role = await freshRole(world);
        await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        const viewer = await candidate(world, 'demand-cache-viewer', { roles: [] });
        const [first] = await demandOf(viewer, [role]);
        const [second] = await demandOf(viewer, [role]);
        expect(second?.computedAt).toBe(first?.computedAt);
      });

      it('FR-MATCH-09: fewer than 5 closed waits -> insufficient_data and no number (C-42)', async () => {
        const role = await freshRole(world);
        await insertSamples(role, [60, 120, 180, 240]);
        const viewer = await candidate(world, 'demand-wait-few', { roles: [] });
        const [item] = await demandOf(viewer, [role]);
        expect(item).toMatchObject({ avgWaitSeconds: null, avgWaitStatus: 'insufficient_data' });
      });

      it('FR-MATCH-09: 5 closed waits -> the average in seconds, status ok', async () => {
        const role = await freshRole(world);
        await insertSamples(role, [60, 120, 180, 240, 300]);
        const viewer = await candidate(world, 'demand-wait-ok', { roles: [] });
        const [item] = await demandOf(viewer, [role]);
        expect(item).toMatchObject({ avgWaitSeconds: 180, avgWaitStatus: 'ok' });
      });

      it('FR-MATCH-09: waits older than 90 days do not count (C-41)', async () => {
        const role = await freshRole(world);
        await insertSamples(role, [60, 120, 180, 240]);
        await insertSamples(role, [86_400], new Date(clock.now().getTime() - 91 * DAY_MS));
        const viewer = await candidate(world, 'demand-wait-old', { roles: [] });
        const [item] = await demandOf(viewer, [role]);
        expect(item).toMatchObject({ avgWaitSeconds: null, avgWaitStatus: 'insufficient_data' });
      });

      it('FR-MATCH-10: a cancelled application leaves no wait sample and leaves the queue count', async () => {
        const role = await freshRole(world);
        const queued = await searchApplication(world, { roles: [role], label: 'cancelled-wait' });
        clock.advance(3_600_000);
        expectOk(
          'cancelSearchApplication',
          await world.as(queued.user).delete('/v1/me/search-application'),
          204,
        );
        expect(await waitSamples(world, queued.application.id)).toEqual([]);
        expect(
          (await applicationRoles(world, queued.application.id)).every((r) => !r.is_active),
        ).toBe(true);
        const [item] = await demandOf(queued.user, [role]);
        expect(item?.queuedCandidates).toBe(0);
        expect(item?.avgWaitStatus).toBe('insufficient_data');
      });

      it('FR-PROF-07: the demand is readable by any signed-in user, anonymous -> 401', async () => {
        expectProblem(
          'getRoleDemand',
          await world.anonymous().get('/v1/demand'),
          401,
          'UNAUTHENTICATED',
        );
      });
    });

    describe('deficit at join (DeficitPort, FR-TEAM-25, FR-MATCH-11)', () => {
      it('FR-TEAM-25: the joining seat counts as open and the queue counts the people waiting: 3 open vs 1 queued -> deficit, numbers stored', async () => {
        const role = await freshRole(world);
        const f = await teamWithDemand(world, { roleCode: role, openSeats: 3, queued: 1 });
        const joiner = await candidate(world, 'deficit-joiner', { roles: [] });
        const seat = f.openSeats[0];
        if (!seat) throw new Error('no seat');
        await joinThroughOffer(world, f.lead, f.id, seat.id, joiner);
        expect(await assignmentDeficit(world, seat.id)).toEqual({
          deficit_at_join: true,
          deficit_open_seats: 3,
          deficit_queued: 1,
        });
      });

      it('FR-MATCH-11: a joiner who is himself queued for the role is not counted in the queue (offer path)', async () => {
        const role = await freshRole(world);
        const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        const queued = await searchApplication(world, { roles: [role], label: 'deficit-self' });
        const seat = f.openSeats[0];
        if (!seat) throw new Error('no seat');
        await joinThroughOffer(world, f.lead, f.id, seat.id, queued.user);
        expect(await assignmentDeficit(world, seat.id)).toEqual({
          deficit_at_join: true,
          deficit_open_seats: 1,
          deficit_queued: 0,
        });
      });

      it('FR-MATCH-11: equality is not a deficit: 1 open vs 1 queued other person', async () => {
        const role = await freshRole(world);
        const f = await teamWithDemand(world, { roleCode: role, openSeats: 1, queued: 1 });
        const joiner = await candidate(world, 'deficit-equal', { roles: [] });
        const seat = f.openSeats[0];
        if (!seat) throw new Error('no seat');
        await joinThroughOffer(world, f.lead, f.id, seat.id, joiner);
        expect(await assignmentDeficit(world, seat.id)).toEqual({
          deficit_at_join: false,
          deficit_open_seats: 1,
          deficit_queued: 1,
        });
      });

      it('FR-TEAM-25: the stored deficit does not change when the market changes afterwards', async () => {
        const role = await freshRole(world);
        const f = await teamWithDemand(world, { roleCode: role, openSeats: 2, queued: 1 });
        const [first, second] = f.openSeats;
        if (!first || !second) throw new Error('no seats');
        const a = await candidate(world, 'deficit-first', { roles: [] });
        const b = await candidate(world, 'deficit-second', { roles: [] });
        await joinThroughOffer(world, f.lead, f.id, first.id, a);
        const stored = await assignmentDeficit(world, first.id);
        expect(stored).toEqual({ deficit_at_join: true, deficit_open_seats: 2, deficit_queued: 1 });
        await joinThroughOffer(world, f.lead, f.id, second.id, b);
        // 1 open vs 1 queued: not a deficit for the second joiner, the first record is untouched
        expect(await assignmentDeficit(world, second.id)).toMatchObject({
          deficit_at_join: false,
        });
        expect(await assignmentDeficit(world, first.id)).toEqual(stored);
      });

      it('FR-TEAM-25 (risk 17.7, accepted): two joins to different seats of one role at the same moment both succeed; each record is consistent with some order', async () => {
        const role = await freshRole(world);
        const a = await team(world, { roleCode: role, openSeats: 1 });
        const b = await team(world, { roleCode: role, openSeats: 1 });
        const [seatA, seatB] = [a.openSeats[0], b.openSeats[0]];
        if (!seatA || !seatB) throw new Error('no seats');
        const [x, y] = [
          await candidate(world, 'race-x', { roles: [] }),
          await candidate(world, 'race-y', { roles: [] }),
        ];
        const offers = [
          expectOk<OfferDto>(
            'createSeatOffer',
            await world
              .as(a.lead)
              .post(`/v1/teams/${a.id}/seat-offers`, { seatId: seatA.id, userId: x.id }),
            201,
          ),
          expectOk<OfferDto>(
            'createSeatOffer',
            await world
              .as(b.lead)
              .post(`/v1/teams/${b.id}/seat-offers`, { seatId: seatB.id, userId: y.id }),
            201,
          ),
        ];
        const [r1, r2] = await Promise.all([
          world.as(x).post(`/v1/seat-offers/${offers[0]?.id}/acceptance`),
          world.as(y).post(`/v1/seat-offers/${offers[1]?.id}/acceptance`),
        ]);
        expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
        for (const seat of [seatA, seatB]) {
          const stored = await assignmentDeficit(world, seat.id);
          expect([1, 2]).toContain(stored.deficit_open_seats);
          expect(stored.deficit_queued).toBe(0);
        }
      });
    });
  },
);

describeInfra('S4 matching: the demand follows the events (FR-MATCH-09)', ['db', 'redis'], () => {
  let world: World;

  beforeAll(async () => {
    world = await startWorld();
  });

  afterAll(async () => {
    if (!world) return;
    await world.close();
  });

  const demandOf = async (viewer: UserFixture, role: string): Promise<RoleDemandDto | undefined> =>
    expectOk<{ items: RoleDemandDto[] }>(
      'getRoleDemand',
      await world.as(viewer).get(`/v1/demand?roles=${role}`),
      200,
    ).items[0];

  it('FR-MATCH-09: new open seats show up in the demand within seconds, not after the cache TTL (recount on teams.seat_opened)', async () => {
    const role = await freshRole(world);
    const viewer = await candidate(world, 'events-seats-viewer', { roles: [] });
    expect(await demandOf(viewer, role)).toMatchObject({ openSeats: 0, teamsSeeking: 0 });
    await team(world, { roleCode: role, openSeats: 2, members: 1 });
    const seen = await waitFor(
      async () => {
        const now = await demandOf(viewer, role);
        return now && now.openSeats === 2 ? now : false;
      },
      25_000,
      250,
    );
    expect(seen).toMatchObject({ openSeats: 2, teamsSeeking: 1 });
  });

  it('FR-MATCH-09: a new application shows up in the queue count within seconds (recount on matching.application_changed)', async () => {
    // a role no seat asks for, so that auto-add cannot take the person out of the queue
    const role = await freshRole(world);
    const viewer = await candidate(world, 'events-queue-viewer', { roles: [role] });
    expect(await demandOf(viewer, role)).toMatchObject({ queuedCandidates: 0 });
    expectOk(
      'createSearchApplication',
      await world.as(viewer).post('/v1/me/search-application', applicationBody([role])),
      201,
    );
    const seen = await waitFor(
      async () => {
        const now = await demandOf(viewer, role);
        return now && now.queuedCandidates === 1 ? now : false;
      },
      25_000,
      250,
    );
    expect(seen.queuedCandidates).toBe(1);
  });
});
