import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import {
  activeApplications,
  applicationRow,
  assignmentDeficit,
  autoAddOutcomes,
  fulfilledApplications,
  membershipRow,
  waitSamples,
} from '../../../../test/fixtures/matching-db.js';
import {
  applicationBody,
  candidate,
  DAY,
  freshRole,
  readTeam,
  runAutoAdd,
  searchApplication,
  teamWithDemand,
  TRIAL_MS,
  waitFulfilled,
} from '../../../../test/fixtures/matching.js';
import { expectOk, joinThroughOffer, team } from '../../../../test/fixtures/teams.js';
import {
  activeMemberships,
  notificationCount,
  seatStatus,
} from '../../../../test/fixtures/teams-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

const HOUR = 3_600_000;
const SETTLE_MS = 7_000;
/** Time for a background run (5 s after the event) to act, when the test expects NOTHING to happen. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

describeInfra(
  'S4 matching: auto-add from the queue (FR-MATCH-05, -06, -07, FR-TEAM-25)',
  ['db', 'redis'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());

    beforeAll(async () => {
      world = await startWorld({ clock });
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    describe('the happy path (FR-MATCH-05)', () => {
      it('a queued person is added to a team with an open seat of the role: member joinedVia auto, trial 7 days, application fulfilled, one wait sample, both sides notified', async () => {
        const role = await freshRole(world);
        const queued = await searchApplication(world, { roles: [role], label: 'happy' });
        const f = await teamWithDemand(world, { roleCode: role, openSeats: 1, members: 2 });
        const seat = f.openSeats[0];
        if (!seat) throw new Error('no seat');
        const candidateNotes = await notificationCount(world, queued.user.id);
        const leadNotes = await notificationCount(world, f.lead.id);
        await runAutoAdd(world);
        await waitFulfilled(world, queued.application.id);

        const dto = await readTeam(world, f.lead, f.id);
        const member = dto.members.find((m) => m.userId === queued.user.id);
        expect(member).toMatchObject({ joinedVia: 'auto', status: 'active' });
        expect(member?.roles).toEqual([role]);
        const joinedAt = Date.parse(member?.joinedAt ?? '');
        expect(Date.parse(member?.trialUntil ?? '') - joinedAt).toBe(TRIAL_MS);
        expect(dto.memberCount).toBe(f.dto.memberCount + 1);
        expect(dto.seats.find((s) => s.id === seat.id)).toMatchObject({
          status: 'filled',
          holderUserId: queued.user.id,
        });

        const row = await applicationRow(world, queued.application.id);
        expect(row).toMatchObject({
          status: 'fulfilled',
          fulfilled_seat_id: seat.id,
          fulfilled_role_code: role,
          fulfilled_team_id: f.id,
        });
        expect((await membershipRow(world, f.id, queued.user.id))?.application_id).toBe(
          queued.application.id,
        );
        expect(await waitSamples(world, queued.application.id)).toHaveLength(1);
        expect(
          (await autoAddOutcomes(world, queued.application.id)).map((o) => o.seat_id),
        ).toContain(seat.id);
        expectProblem(
          'getMySearchApplication',
          await world.as(queued.user).get('/v1/me/search-application'),
          404,
          'APPLICATION_NOT_FOUND',
        );
        await waitFor(
          async () =>
            (await notificationCount(world, queued.user.id)) > candidateNotes &&
            (await notificationCount(world, f.lead.id)) > leadNotes,
          20_000,
          100,
        );
      });

      it('FR-TEAM-25: an auto-add counts the person as queued; 1 open seat vs 1 queued is no deficit, the numbers are stored', async () => {
        const role = await freshRole(world);
        const queued = await searchApplication(world, { roles: [role], label: 'deficit-auto' });
        const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        await runAutoAdd(world);
        await waitFulfilled(world, queued.application.id);
        expect(await assignmentDeficit(world, f.openSeats[0]?.id ?? '')).toEqual({
          deficit_at_join: false,
          deficit_open_seats: 1,
          deficit_queued: 1,
        });
      });

      it('FR-MATCH-09, FR-MATCH-10: the wait sample is the time between enqueuedAt and the add (a fake hour)', async () => {
        const role = await freshRole(world);
        const queued = await searchApplication(world, { roles: [role], label: 'wait-hour' });
        clock.advance(HOUR);
        await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        await runAutoAdd(world);
        await waitFulfilled(world, queued.application.id);
        const [sample] = await waitSamples(world, queued.application.id);
        expect(sample?.role_code).toBe(role);
        expect(sample?.waited_seconds).toBeGreaterThanOrEqual(3600);
        expect(sample?.waited_seconds).toBeLessThan(3600 + 120);
      });

      it('FR-MATCH-05: a repeated run changes nothing - one member, one sample, application stays fulfilled', async () => {
        const role = await freshRole(world);
        const queued = await searchApplication(world, { roles: [role], label: 'repeat' });
        const f = await teamWithDemand(world, { roleCode: role, openSeats: 2 });
        await runAutoAdd(world);
        await waitFulfilled(world, queued.application.id);
        await runAutoAdd(world);
        await runAutoAdd(world);
        expect(await activeMemberships(world, f.id)).toBe(f.dto.memberCount + 1);
        expect(await waitSamples(world, queued.application.id)).toHaveLength(1);
        expect(await fulfilledApplications(world, queued.user.id)).toBe(1);
        expect(await activeApplications(world, queued.user.id)).toBe(0);
        const open = f.openSeats.filter((s) => s.id !== undefined);
        const statuses = await Promise.all(open.map((s) => seatStatus(world, s.id)));
        expect(statuses.filter((s) => s === 'filled')).toHaveLength(1);
      });

      it('FR-MATCH-05: after the add the person may stand in the queue again (a new application)', async () => {
        const role = await freshRole(world);
        const queued = await searchApplication(world, { roles: [role], label: 'again' });
        await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        await runAutoAdd(world);
        await waitFulfilled(world, queued.application.id);
        const second = await world
          .as(queued.user)
          .post('/v1/me/search-application', applicationBody([role]));
        expectOk('createSearchApplication', second, 201);
        expect(await activeApplications(world, queued.user.id)).toBe(1);
      });
    });

    describe('who is added (FR-MATCH-12 filters, C-45 threshold)', () => {
      it('a seat that wants a higher level than the person has is not filled', async () => {
        const role = await freshRole(world);
        const queued = await searchApplication(world, { roles: [role], label: 'low-level' });
        const f = await teamWithDemand(world, {
          roleCode: role,
          openSeats: 1,
          seat: { minLevel: 'middle' },
        });
        await runAutoAdd(world);
        await settle();
        expect((await applicationRow(world, queued.application.id)).status).toBe('active');
        expect(await seatStatus(world, f.openSeats[0]?.id ?? '')).toBe('open');
      });

      it('a pair under the threshold 0.5 (no stack match, one step above the minimum level) is recommended but not auto-added (C-45)', async () => {
        const role = await freshRole(world);
        const person = await candidate(world, 'under-threshold', {
          roles: [role],
          level: 'middle',
          stack: [],
        });
        const queued = await searchApplication(world, { roles: [role], user: person });
        const f = await teamWithDemand(world, {
          roleCode: role,
          openSeats: 1,
          seat: { minLevel: 'beginner', minHours: 6 },
        });
        await runAutoAdd(world);
        await settle();
        expect((await applicationRow(world, queued.application.id)).status).toBe('active');
        expect(await seatStatus(world, f.openSeats[0]?.id ?? '')).toBe('open');
      });

      it('a closed seat is not filled', async () => {
        const role = await freshRole(world);
        const f = await teamWithDemand(world, { roleCode: role, openSeats: 2 });
        const seat = f.openSeats[0];
        if (!seat) throw new Error('no seat');
        expect(
          (await world.as(f.lead).delete(`/v1/teams/${f.id}/seats/${seat.id}`)).statusCode,
        ).toBe(204);
        const queued = await searchApplication(world, { roles: [role], label: 'closed-seat' });
        await runAutoAdd(world);
        await waitFulfilled(world, queued.application.id);
        expect(await seatStatus(world, seat.id)).toBe('closed');
        expect((await applicationRow(world, queued.application.id)).fulfilled_seat_id).toBe(
          f.openSeats[1]?.id,
        );
      });
    });

    describe('role choice among several matches (FR-MATCH-06)', () => {
      it('found in the same run: the role with the smaller priority number wins - [A, B] gives A', async () => {
        const [a, b] = [await freshRole(world), await freshRole(world)];
        const ta = await teamWithDemand(world, { roleCode: a, openSeats: 1 });
        const tb = await teamWithDemand(world, { roleCode: b, openSeats: 1 });
        const queued = await searchApplication(world, { roles: [a, b], label: 'prio-ab' });
        await runAutoAdd(world);
        await waitFulfilled(world, queued.application.id);
        expect(await applicationRow(world, queued.application.id)).toMatchObject({
          fulfilled_role_code: a,
          fulfilled_team_id: ta.id,
        });
        expect(await seatStatus(world, tb.openSeats[0]?.id ?? '')).toBe('open');
      });

      it('found in the same run: the same seats with the priorities swapped - [B, A] gives B (both orders)', async () => {
        const [a, b] = [await freshRole(world), await freshRole(world)];
        await teamWithDemand(world, { roleCode: a, openSeats: 1 });
        const tb = await teamWithDemand(world, { roleCode: b, openSeats: 1 });
        const queued = await searchApplication(world, { roles: [b, a], label: 'prio-ba' });
        await runAutoAdd(world);
        await waitFulfilled(world, queued.application.id);
        expect(await applicationRow(world, queued.application.id)).toMatchObject({
          fulfilled_role_code: b,
          fulfilled_team_id: tb.id,
        });
      });

      it('a match found in an earlier window beats a higher priority: the seat of B opened first, the seat of A five minutes later -> B', async () => {
        const [a, b] = [await freshRole(world), await freshRole(world)];
        const tb = await teamWithDemand(world, { roleCode: b, openSeats: 1 });
        const queued = await searchApplication(world, { roles: [a, b], label: 'earlier-window' });
        clock.advance(5 * 60_000);
        await teamWithDemand(world, { roleCode: a, openSeats: 1 });
        await runAutoAdd(world);
        await waitFulfilled(world, queued.application.id);
        expect(await applicationRow(world, queued.application.id)).toMatchObject({
          fulfilled_role_code: b,
          fulfilled_team_id: tb.id,
        });
      });
    });

    describe('fairness of the queue (FR-MATCH-05, architecture 6.4 step 3)', () => {
      it('the person who waits longest gets the only seat; the others stay active', async () => {
        const role = await freshRole(world);
        const first = await searchApplication(world, { roles: [role], label: 'fair-1' });
        clock.advance(10_000);
        const second = await searchApplication(world, { roles: [role], label: 'fair-2' });
        clock.advance(10_000);
        const third = await searchApplication(world, { roles: [role], label: 'fair-3' });
        const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        await runAutoAdd(world);
        await waitFulfilled(world, first.application.id);
        await settle();
        expect((await applicationRow(world, second.application.id)).status).toBe('active');
        expect((await applicationRow(world, third.application.id)).status).toBe('active');
        expect(await activeMemberships(world, f.id)).toBe(f.dto.memberCount + 1);
      });
    });

    describe('protection of the add (FR-MATCH-07)', () => {
      it('a person with 2 active projects (C-10) is skipped and stays in the queue; when a slot frees up, the next run adds him', async () => {
        const role = await freshRole(world);
        const person = await candidate(world, 'limit', { roles: [role] });
        const firstTeam = await team(world, { openSeats: 1 });
        const secondTeam = await team(world, { openSeats: 1 });
        for (const t of [firstTeam, secondTeam]) {
          const seat = t.openSeats[0];
          if (!seat) throw new Error('no seat');
          await joinThroughOffer(world, t.lead, t.id, seat.id, person);
        }
        const queued = await searchApplication(world, { roles: [role], user: person });
        const target = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        await runAutoAdd(world);
        await settle();
        expect((await applicationRow(world, queued.application.id)).status).toBe('active');
        expect(await seatStatus(world, target.openSeats[0]?.id ?? '')).toBe('open');

        expectOk(
          'leaveTeam',
          await world.as(person).delete(`/v1/teams/${secondTeam.id}/members/me`),
          204,
        );
        await runAutoAdd(world);
        await waitFulfilled(world, queued.application.id);
        expect(await membershipRow(world, target.id, person.id)).toMatchObject({
          status: 'active',
          joined_via: 'auto',
        });
      });

      it('a person whose GitHub was unlinked is skipped and stays in the queue', async () => {
        const role = await freshRole(world);
        const queued = await searchApplication(world, { roles: [role], label: 'no-github-later' });
        await world.sql`
          UPDATE auth."user" SET github_user_id = NULL, github_login = NULL WHERE id = ${queued.user.id}`;
        const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        await runAutoAdd(world);
        await settle();
        expect((await applicationRow(world, queued.application.id)).status).toBe('active');
        expect(await seatStatus(world, f.openSeats[0]?.id ?? '')).toBe('open');
      });

      it('a person without a valid consent is skipped and stays in the queue', async () => {
        const role = await freshRole(world);
        const queued = await searchApplication(world, { roles: [role], label: 'no-consent-later' });
        await world.sql`DELETE FROM auth.consent WHERE user_id = ${queued.user.id}`;
        const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        await runAutoAdd(world);
        await settle();
        expect((await applicationRow(world, queued.application.id)).status).toBe('active');
        expect(await seatStatus(world, f.openSeats[0]?.id ?? '')).toBe('open');
      });

      it('a team of 8 (C-02) with an open seat is skipped; the next team gets the person', async () => {
        const role = await freshRole(world);
        const full = await team(world, { members: 8, roleCode: role, openSeats: 1 });
        const queued = await searchApplication(world, { roles: [role], label: 'full-team' });
        await runAutoAdd(world);
        await settle();
        expect((await applicationRow(world, queued.application.id)).status).toBe('active');
        expect(await seatStatus(world, full.openSeats[0]?.id ?? '')).toBe('open');
        const free = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        await runAutoAdd(world);
        await waitFulfilled(world, queued.application.id);
        expect((await applicationRow(world, queued.application.id)).fulfilled_team_id).toBe(
          free.id,
        );
      });

      it('a person who is already in the team is not added to its second seat of the role', async () => {
        const role = await freshRole(world);
        const person = await candidate(world, 'already-member', { roles: [role] });
        const f = await team(world, { roleCode: role, openSeats: 2 });
        const [first, second] = f.openSeats;
        if (!first || !second) throw new Error('no seats');
        await joinThroughOffer(world, f.lead, f.id, first.id, person);
        const queued = await searchApplication(world, { roles: [role], user: person });
        await runAutoAdd(world);
        await settle();
        expect((await applicationRow(world, queued.application.id)).status).toBe('active');
        expect(await seatStatus(world, second.id)).toBe('open');
      });

      it('a cancelled application is never added', async () => {
        const role = await freshRole(world);
        const queued = await searchApplication(world, { roles: [role], label: 'cancelled' });
        expectOk(
          'cancelSearchApplication',
          await world.as(queued.user).delete('/v1/me/search-application'),
          204,
        );
        const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        await runAutoAdd(world);
        await settle();
        expect(await seatStatus(world, f.openSeats[0]?.id ?? '')).toBe('open');
        expect((await applicationRow(world, queued.application.id)).status).toBe('cancelled');
      });
    });

    describe('the trial period of an auto-added member (FR-MATCH-05, FR-TEAM-09)', () => {
      it('a person who joins through an offer has no trial period; only the auto-add sets trial_until', async () => {
        const f = await team(world, { openSeats: 1 });
        const seat = f.openSeats[0];
        if (!seat) throw new Error('no seat');
        const person = await candidate(world, 'offer-no-trial', { roles: [] });
        await joinThroughOffer(world, f.lead, f.id, seat.id, person);
        const dto = await readTeam(world, f.lead, f.id);
        const member = dto.members.find((m) => m.userId === person.id);
        expect(member).toMatchObject({ joinedVia: 'offer', trialUntil: null });
      });

      it('trialUntil is exactly seven days after the add on the fake clock', async () => {
        const role = await freshRole(world);
        const queued = await searchApplication(world, { roles: [role], label: 'trial-seven' });
        clock.advance(DAY);
        const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
        const before = clock.now().getTime();
        await runAutoAdd(world);
        await waitFulfilled(world, queued.application.id);
        const row = await membershipRow(world, f.id, queued.user.id);
        expect(row?.joined_via).toBe('auto');
        expect(row?.trial_until?.getTime()).toBe((row?.joined_at.getTime() ?? 0) + TRIAL_MS);
        expect(row?.joined_at.getTime()).toBeGreaterThanOrEqual(before);
        expect(row?.trial_confirmed_at).toBeNull();
      });
    });
  },
);
