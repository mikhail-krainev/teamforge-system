import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import {
  DAY,
  currentVote,
  expectOk,
  githubUser,
  team,
  type DepartureDto,
  type TeamDto,
} from '../../../../test/fixtures/teams.js';
import {
  activeMembershipsOf,
  openVotes,
  seatStatus,
  teamRow,
} from '../../../../test/fixtures/teams-db.js';
import { fireTimer } from '../../../../test/fixtures/teams-timers.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

describeInfra(
  'S3 teams: leaving a team and the lead decision (FR-TEAM-11, -12, -13, -14)',
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

    const departures = async (
      t: { id: string },
      who: Parameters<World['as']>[0],
    ): Promise<DepartureDto[]> =>
      expectOk<{ items: DepartureDto[] }>(
        'listDepartures',
        await world.as(who).get(`/v1/teams/${t.id}/departures`),
        200,
      ).items;

    describe('leaveTeam', () => {
      it('FR-TEAM-11: a member leaves: 204, the seat opens again, the member count drops', async () => {
        const t = await team(world, { members: 3, openSeats: 0 });
        const member = t.members[0];
        const seat = t.seats.find((s) => s.holderUserId === member?.id);
        if (!member || !seat) throw new Error('no fixture');
        expectOk('leaveTeam', await world.as(member).delete(`/v1/teams/${t.id}/members/me`), 204);
        expect(await seatStatus(world, seat.id)).toBe('open');
        expect((await teamRow(world, t.id)).member_count).toBe(2);
        const dto = expectOk<TeamDto>(
          'getTeam',
          await world.as(t.lead).get(`/v1/teams/${t.id}`),
          200,
        );
        expect(dto.members.map((m) => m.userId)).not.toContain(member.id);
      });

      it('FR-TEAM-11, -05: the project slot of the leaver is free immediately', async () => {
        const t = await team(world, { members: 2, openSeats: 0 });
        const member = t.members[0];
        if (!member) throw new Error('no member');
        expect(await activeMembershipsOf(world, member.id)).toBe(1);
        await world.as(member).delete(`/v1/teams/${t.id}/members/me`);
        expect(await activeMembershipsOf(world, member.id)).toBe(0);
      });

      it('FR-TEAM-12: the leave opens a decision for the lead (pending, due in 7 days, C-14)', async () => {
        const t = await team(world, { members: 2, openSeats: 0 });
        const member = t.members[0];
        if (!member) throw new Error('no member');
        await world.as(member).delete(`/v1/teams/${t.id}/members/me`);
        const list = await departures(t, t.lead);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ userId: member.id, decision: 'pending' });
        expect(list[0]?.seatIds).toHaveLength(1);
        expect(Date.parse(list[0]?.dueAt ?? '') - clock.now().getTime()).toBeLessThanOrEqual(
          7 * DAY + 5_000,
        );
        expect(Date.parse(list[0]?.dueAt ?? '') - clock.now().getTime()).toBeGreaterThan(6.9 * DAY);
      });

      it('FR-TEAM-11, FR-WORK-19: the lead gets a notification about the leave', async () => {
        const t = await team(world, { members: 2, openSeats: 0 });
        const member = t.members[0];
        if (!member) throw new Error('no member');
        await world.as(member).delete(`/v1/teams/${t.id}/members/me`);
        const found = await waitFor(async () => {
          const page = expectOk<{ items: { payload: Record<string, unknown> }[] }>(
            'listNotifications',
            await world.as(t.lead).get('/v1/me/notifications'),
            200,
          );
          return page.items.some((n) => JSON.stringify(n.payload).includes(t.id));
        }, 20_000);
        expect(found).toBe(true);
      });

      it('FR-TEAM-11: leaving twice: the second call (new key) -> 404, the same key replays the 204', async () => {
        const t = await team(world, { members: 2, openSeats: 0 });
        const member = t.members[0];
        if (!member) throw new Error('no member');
        const key = randomUUID();
        expectOk(
          'leaveTeam',
          await world.as(member).delete(`/v1/teams/${t.id}/members/me`, { idempotencyKey: key }),
          204,
        );
        const replay = await world
          .as(member)
          .delete(`/v1/teams/${t.id}/members/me`, { idempotencyKey: key });
        expect(replay.statusCode).toBe(204);
        expectReplayed(replay);
        expectProblem(
          'leaveTeam',
          await world.as(member).delete(`/v1/teams/${t.id}/members/me`),
          404,
          'NOT_FOUND',
        );
      });

      it('FR-TEAM-11: a user outside the team gets 404', async () => {
        const t = await team(world);
        const stranger = await githubUser(world, 'leave-stranger');
        expectProblem(
          'leaveTeam',
          await world.as(stranger).delete(`/v1/teams/${t.id}/members/me`),
          404,
          'NOT_FOUND',
        );
      });

      it('FR-TEAM-14: the lead leaving opens exactly one vote; the team is `voting` and has no lead', async () => {
        const t = await team(world, { members: 3, openSeats: 0, status: 'active' });
        expectOk('leaveTeam', await world.as(t.lead).delete(`/v1/teams/${t.id}/members/me`), 204);
        expect(await teamRow(world, t.id)).toMatchObject({ status: 'voting', lead_user_id: null });
        expect(await openVotes(world, t.id)).toBe(1);
        const member = t.members[0];
        if (!member) throw new Error('no member');
        const vote = await currentVote(world, member, t.id);
        expect(vote).toMatchObject({
          status: 'nominating',
          trigger: 'lead_left',
          eligibleCount: 2,
        });
      });

      it('FR-TEAM-14: if one member is left, he becomes the lead without a vote (sole_member)', async () => {
        const t = await team(world, { members: 2, openSeats: 0, status: 'active' });
        const member = t.members[0];
        if (!member) throw new Error('no member');
        await world.as(t.lead).delete(`/v1/teams/${t.id}/members/me`);
        expect(await teamRow(world, t.id)).toMatchObject({
          status: 'active',
          lead_user_id: member.id,
        });
        const vote = await currentVote(world, member, t.id);
        expect(vote).toMatchObject({ status: 'closed', outcome: 'sole_member' });
      });

      it('FR-TEAM-14: if nobody is left, the team is archived', async () => {
        const t = await team(world, { members: 1, openSeats: 1 });
        await world.as(t.lead).delete(`/v1/teams/${t.id}/members/me`);
        expect((await teamRow(world, t.id)).status).toBe('archived');
      });
    });

    describe('listDepartures', () => {
      it('FR-TEAM-12: every member can read it; a stranger gets 404', async () => {
        const t = await team(world, { members: 3, openSeats: 0 });
        const [leaver, other] = t.members;
        if (!leaver || !other) throw new Error('no members');
        await world.as(leaver).delete(`/v1/teams/${t.id}/members/me`);
        expect(await departures(t, other)).toHaveLength(1);
        const stranger = await githubUser(world, 'departures-stranger');
        expectProblem(
          'listDepartures',
          await world.as(stranger).get(`/v1/teams/${t.id}/departures`),
          404,
          'NOT_FOUND',
        );
      });
    });

    it('FR-TEAM-13: a departure lists the checklist items left without an assignee (none before slice 5)', async () => {
      const t = await team(world, { members: 2, openSeats: 0 });
      const member = t.members[0];
      if (!member) throw new Error('no member');
      await world.as(member).delete(`/v1/teams/${t.id}/members/me`);
      const [departure] = await departures(t, t.lead);
      expect(departure?.unassignedItemIds).toEqual([]);
    });

    describe('decideDeparture', () => {
      async function oneDeparture() {
        const t = await team(world, { members: 3, openSeats: 0, status: 'active' });
        const leaver = t.members[0];
        if (!leaver) throw new Error('no member');
        await world.as(leaver).delete(`/v1/teams/${t.id}/members/me`);
        const [departure] = await departures(t, t.lead);
        if (!departure) throw new Error('no departure');
        return { t, leaver, departure };
      }

      it('FR-TEAM-12: "replace" keeps the seat open', async () => {
        const { t, departure } = await oneDeparture();
        const response = await world
          .as(t.lead)
          .post(`/v1/teams/${t.id}/departures/${departure.id}/decision`, { decision: 'replace' });
        expect(expectOk<DepartureDto>('decideDeparture', response, 200)).toMatchObject({
          decision: 'replace',
        });
        expect(await seatStatus(world, departure.seatIds[0] ?? '')).toBe('open');
      });

      it('FR-TEAM-12: "continue" with closeSeatIds closes the seat', async () => {
        const { t, departure } = await oneDeparture();
        const response = await world
          .as(t.lead)
          .post(`/v1/teams/${t.id}/departures/${departure.id}/decision`, {
            decision: 'continue',
            closeSeatIds: departure.seatIds,
          });
        expect(expectOk<DepartureDto>('decideDeparture', response, 200).decision).toBe('continue');
        expect(await seatStatus(world, departure.seatIds[0] ?? '')).toBe('closed');
      });

      it('FR-TEAM-12: a second decision -> 409 INVALID_STATE', async () => {
        const { t, departure } = await oneDeparture();
        await world
          .as(t.lead)
          .post(`/v1/teams/${t.id}/departures/${departure.id}/decision`, { decision: 'replace' });
        const again = await world
          .as(t.lead)
          .post(`/v1/teams/${t.id}/departures/${departure.id}/decision`, { decision: 'continue' });
        expectProblem('decideDeparture', again, 409, 'INVALID_STATE');
      });

      it('FR-TEAM-12: a member who is not the lead -> 403 NOT_TEAM_LEAD; an unknown departure -> 404', async () => {
        const { t, departure } = await oneDeparture();
        const member = t.members[1];
        if (!member) throw new Error('no member');
        expectProblem(
          'decideDeparture',
          await world
            .as(member)
            .post(`/v1/teams/${t.id}/departures/${departure.id}/decision`, { decision: 'replace' }),
          403,
          'NOT_TEAM_LEAD',
        );
        expectProblem(
          'decideDeparture',
          await world
            .as(t.lead)
            .post(`/v1/teams/${t.id}/departures/${randomUUID()}/decision`, { decision: 'replace' }),
          404,
          'NOT_FOUND',
        );
      });

      it('FR-TEAM-12: an invalid decision -> 400 VALIDATION_FAILED', async () => {
        const { t, departure } = await oneDeparture();
        const response = await world
          .as(t.lead)
          .post(`/v1/teams/${t.id}/departures/${departure.id}/decision`, { decision: 'maybe' });
        expectProblem('decideDeparture', response, 400, 'VALIDATION_FAILED');
      });

      it('FR-TEAM-12 (C-14): unattended for 7 days, the default timer decides "replace" and the seat stays open', async () => {
        const { t, departure } = await oneDeparture();
        clock.advance(8 * DAY);
        await fireTimer(world, 'departure-default', { departureId: departure.id });
        const after = (await departures(t, t.lead)).find((d) => d.id === departure.id);
        expect(after?.decision).toBe('replace');
        expect(await seatStatus(world, departure.seatIds[0] ?? '')).toBe('open');
        const late = await world
          .as(t.lead)
          .post(`/v1/teams/${t.id}/departures/${departure.id}/decision`, { decision: 'continue' });
        expectProblem('decideDeparture', late, 409, 'INVALID_STATE');
      });
    });
  },
);
