import { afterAll, beforeAll, expect, it } from 'vitest';
import { codesAt, expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import {
  DAY,
  expectOk,
  githubUser,
  manyGithubUsers,
  team,
  type DepartureDto,
} from '../fixtures/teams.js';
import {
  activeInvitations,
  expectNoDeadlocks,
  pendingOffers,
  seatStatus,
} from '../fixtures/teams-db.js';
import { fireTimer } from '../fixtures/teams-timers.js';
import { World } from '../fixtures/world.js';
import { FakeClock } from '../helpers/clock.js';
import { describeInfra } from '../helpers/infra.js';

const N = 20;

describeInfra(
  'Races of architecture 12.3: limits and the departure decision',
  ['db', 'redis'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());
    let deadlocksBefore = 0;

    beforeAll(async () => {
      world = await World.start({ clock });
      await world.ensureCatalog(['backend', 'frontend', 'pm', 'designer', 'qa', 'devops']);
      deadlocksBefore = await world.deadlocks();
    });

    afterAll(async () => {
      if (!world) return;
      await expectNoDeadlocks(world, deadlocksBefore);
      await world.close();
    });

    it('12.3 (R-5): 29 pending offers, then 20 parallel offers -> exactly one more succeeds, 19 x OFFER_LIMIT (30 per team)', async () => {
      const t = await team(world, { openSeats: 1 });
      const seat = t.openSeats[0];
      if (!seat) throw new Error('no seat');
      const users = await manyGithubUsers(world, 'limit-offer', 29 + N);
      for (const u of users.slice(0, 29)) {
        expectOk(
          'createSeatOffer',
          await world
            .as(t.lead)
            .post(`/v1/teams/${t.id}/seat-offers`, { seatId: seat.id, userId: u.id }),
          201,
        );
      }
      const racers = users.slice(29);
      const fired = await fireAll(N, (i, key) =>
        world
          .as(t.lead)
          .post(
            `/v1/teams/${t.id}/seat-offers`,
            { seatId: seat.id, userId: racers[i]?.id },
            { idempotencyKey: key },
          ),
      );
      expect(tally(fired)).toEqual({ 201: 1, 409: N - 1 });
      expect(codesAt(fired, 409)).toEqual(['OFFER_LIMIT']);
      expect(await pendingOffers(world, t.id)).toBe(30);
      const winner = winnerOf(fired, 201);
      expectReplayOf(
        winner,
        await world
          .as(t.lead)
          .post(
            `/v1/teams/${t.id}/seat-offers`,
            { seatId: seat.id, userId: racers[winner.index]?.id },
            { idempotencyKey: winner.key },
          ),
      );
      expect(await pendingOffers(world, t.id)).toBe(30);
    });

    it('12.3 (R-5): 9 pending requests of one candidate, then 20 parallel requests -> exactly one more succeeds (10 per candidate)', async () => {
      const teams = await Promise.all([
        team(world, { openSeats: 11 }),
        team(world, { openSeats: 11 }),
        team(world, { openSeats: 11 }),
      ]);
      const seats = teams.flatMap((t) => t.openSeats.map((s) => ({ teamId: t.id, seatId: s.id })));
      const candidate = await githubUser(world, 'limit-request');
      for (const s of seats.slice(0, 9)) {
        expectOk(
          'createJoinRequest',
          await world
            .as(candidate)
            .post(`/v1/teams/${s.teamId}/join-requests`, { seatId: s.seatId }),
          201,
        );
      }
      const racers = seats.slice(9, 9 + N);
      const fired = await fireAll(N, (i, key) => {
        const target = racers[i];
        return world
          .as(candidate)
          .post(
            `/v1/teams/${target?.teamId}/join-requests`,
            { seatId: target?.seatId },
            { idempotencyKey: key },
          );
      });
      expect(tally(fired)).toEqual({ 201: 1, 409: N - 1 });
      expect(codesAt(fired, 409)).toEqual(['OFFER_LIMIT']);
      const pending = await world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM teams.seat_offer WHERE user_id = ${candidate.id} AND direction = 'user_to_lead' AND status = 'pending'`;
      expect(pending[0]?.n).toBe(10);
      const winner = winnerOf(fired, 201);
      const target = racers[winner.index];
      expectReplayOf(
        winner,
        await world
          .as(candidate)
          .post(
            `/v1/teams/${target?.teamId}/join-requests`,
            { seatId: target?.seatId },
            { idempotencyKey: winner.key },
          ),
      );
    });

    it('12.3 (C-13): 19 active invitations, then 20 parallel ones -> exactly one more, 19 x INVITATION_LIMIT', async () => {
      const t = await team(world, { openSeats: 1 });
      const seat = t.openSeats[0];
      if (!seat) throw new Error('no seat');
      for (let i = 0; i < 19; i += 1) {
        expectOk(
          'createInvitation',
          await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }),
          201,
        );
      }
      const fired = await fireAll(N, (_i, key) =>
        world
          .as(t.lead)
          .post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }, { idempotencyKey: key }),
      );
      expect(tally(fired)).toEqual({ 201: 1, 409: N - 1 });
      expect(codesAt(fired, 409)).toEqual(['INVITATION_LIMIT']);
      expect(await activeInvitations(world, t.id)).toBe(20);
      const winner = winnerOf(fired, 201);
      const replay = await world
        .as(t.lead)
        .post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }, { idempotencyKey: winner.key });
      expectReplayOf(winner, replay);
      expect(await activeInvitations(world, t.id)).toBe(20);
    });

    it('12.3 (S3CR-01): accepting an expired offer against creating a new offer for the same seat and user -> no deadlock, one live offer', async () => {
      const t = await team(world, { openSeats: 1 });
      const seat = t.openSeats[0];
      if (!seat) throw new Error('no seat');
      const candidate = await githubUser(world, 'race-expired-offer');
      const old = expectOk<{ id: string }>(
        'createSeatOffer',
        await world
          .as(t.lead)
          .post(`/v1/teams/${t.id}/seat-offers`, { seatId: seat.id, userId: candidate.id }),
        201,
      );
      clock.advance(8 * DAY);
      const fired = await fireAll(N, (i, key) =>
        i % 2 === 0
          ? world
              .as(candidate)
              .post(`/v1/seat-offers/${old.id}/acceptance`, undefined, { idempotencyKey: key })
          : world
              .as(t.lead)
              .post(
                `/v1/teams/${t.id}/seat-offers`,
                { seatId: seat.id, userId: candidate.id },
                { idempotencyKey: key },
              ),
      );
      const accepts = fired.filter((f) => f.index % 2 === 0);
      const creates = fired.filter((f) => f.index % 2 === 1);
      expect(accepts.every((f) => f.status === 409 && f.code === 'INVALID_STATE')).toBe(true);
      expect(creates.filter((f) => f.status === 201)).toHaveLength(1);
      expect(creates.filter((f) => f.status !== 201).every((f) => f.status === 409)).toBe(true);
      expect(codesAt(creates, 409)).toEqual(['INVALID_STATE']);
      const rows = await world.sql<{ id: string; status: string }[]>`
        SELECT id, status FROM teams.seat_offer WHERE seat_id = ${seat.id} AND user_id = ${candidate.id}`;
      expect(rows.find((r) => r.id === old.id)?.status).toBe('expired');
      expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
      expect(await seatStatus(world, seat.id)).toBe('open');
    });

    it('12.3 (C-14): the lead decision against the default timer -> one final decision, never two', async () => {
      const t = await team(world, { members: 3, openSeats: 0, status: 'active' });
      const leaver = t.members[0];
      if (!leaver) throw new Error('no member');
      await world.as(leaver).delete(`/v1/teams/${t.id}/members/me`);
      const list = expectOk<{ items: DepartureDto[] }>(
        'listDepartures',
        await world.as(t.lead).get(`/v1/teams/${t.id}/departures`),
        200,
      );
      const departure = list.items[0];
      if (!departure) throw new Error('no departure');
      clock.advance(8 * DAY);
      const url = `/v1/teams/${t.id}/departures/${departure.id}/decision`;
      const body = { decision: 'continue', closeSeatIds: departure.seatIds };
      const fired = await fireAll(N, (i, key) => {
        if (i === 0)
          return fireTimer(world, 'departure-default', { departureId: departure.id }).then(() =>
            world.as(t.lead).get(`/v1/teams/${t.id}/departures`),
          );
        return world.as(t.lead).post(url, body, { idempotencyKey: key });
      });
      const decisions = fired.filter((r) => r.index > 0);
      expect(decisions.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
      expect(
        decisions
          .filter((r) => r.status !== 200)
          .every((r) => r.status === 409 && r.code === 'INVALID_STATE'),
      ).toBe(true);
      const final = await world.sql<{ decision: string; decided_by: string | null }[]>`
      SELECT decision, decided_by FROM teams.departure WHERE id = ${departure.id}`;
      expect(['replace', 'continue']).toContain(final[0]?.decision);
      const seat = await seatStatus(world, departure.seatIds[0] ?? '');
      // The lead's "continue + close" and the timer's "replace" exclude each other: the seat state tells which one won.
      expect(seat).toBe(final[0]?.decision === 'continue' ? 'closed' : 'open');
      const winner = decisions.find((r) => r.status === 200);
      if (winner)
        expectReplayOf(
          winner,
          await world.as(t.lead).post(url, body, { idempotencyKey: winner.key }),
        );
    });
  },
);
