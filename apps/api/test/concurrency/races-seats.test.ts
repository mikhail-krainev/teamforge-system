import { afterAll, beforeAll, expect, it } from 'vitest';
import { codesAt, expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import { manyGithubUsers, seatInput, team, teamWithOpenSeat } from '../fixtures/teams.js';
import {
  activeAssignments,
  activeMemberships,
  expectNoDeadlocks,
  seatStatus,
  teamRow,
} from '../fixtures/teams-db.js';
import { World } from '../fixtures/world.js';
import type { InjectResponse } from '../helpers/http.js';
import { describeInfra } from '../helpers/infra.js';

const N = 20;

describeInfra('Races of architecture 12.3: seats against joins and leaves', ['db', 'redis'], () => {
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

  it('12.3: closing a seat against joining it (10 joins + 10 closes) -> one outcome, the seat is never lost', async () => {
    const f = await teamWithOpenSeat(world, { candidates: 10 });
    const fired = await fireAll(N, (i, key) =>
      i < 10
        ? world
            .as(f.candidates[i] ?? f.lead)
            .post(`/v1/seat-offers/${f.offers[i]?.id}/acceptance`, undefined, {
              idempotencyKey: key,
            })
        : world.as(f.lead).delete(`/v1/teams/${f.id}/seats/${f.seat.id}`, { idempotencyKey: key }),
    );
    const joins = fired.filter((r) => r.index < 10);
    const closes = fired.filter((r) => r.index >= 10);
    const status = await seatStatus(world, f.seat.id);
    expect(['filled', 'closed']).toContain(status);
    if (status === 'filled') {
      expect(tally(joins)).toEqual({ 200: 1, 409: 9 });
      expect(codesAt(joins, 409)).toEqual(['SEAT_TAKEN']);
      expect(closes.every((r) => r.status === 409 && r.code === 'INVALID_STATE')).toBe(true);
      expect(await activeAssignments(world, f.seat.id)).toBe(1);
    } else {
      expect(tally(closes)[204]).toBe(1);
      expect(joins.every((r) => r.status === 409 && r.code === 'SEAT_NOT_OPEN')).toBe(true);
      expect(await activeAssignments(world, f.seat.id)).toBe(0);
    }
    expect((await teamRow(world, f.id)).member_count).toBe(status === 'filled' ? 2 : 1);
    const first = fired.find((r) => r.status === 200 || r.status === 204);
    if (!first) throw new Error('no winner');
    const replay =
      first.index < 10
        ? await world
            .as(f.candidates[first.index] ?? f.lead)
            .post(`/v1/seat-offers/${f.offers[first.index]?.id}/acceptance`, undefined, {
              idempotencyKey: first.key,
            })
        : await world
            .as(f.lead)
            .delete(`/v1/teams/${f.id}/seats/${f.seat.id}`, { idempotencyKey: first.key });
    expectReplayOf(first, replay);
    expect(await seatStatus(world, f.seat.id)).toBe(status);
  });

  it('12.3: a member leaving against joins on the free seat of a full team -> member_count always equals the active members', async () => {
    const f = await teamWithOpenSeat(world, { members: 8, openSeats: 1, candidates: 15 });
    const leaver = f.members[0];
    const leaverSeat = f.seats.find((s) => s.holderUserId === leaver?.id);
    if (!leaver || !leaverSeat) throw new Error('fixture');
    const fired = await fireAll(N, (i, key) =>
      i < 15
        ? world
            .as(f.candidates[i] ?? f.lead)
            .post(`/v1/seat-offers/${f.offers[i]?.id}/acceptance`, undefined, {
              idempotencyKey: key,
            })
        : world.as(leaver).delete(`/v1/teams/${f.id}/members/me`, { idempotencyKey: key }),
    );
    const joins = fired.filter((r) => r.index < 15);
    const leaves = fired.filter((r) => r.index >= 15);
    expect(tally(leaves)[204]).toBe(1);
    expect(joins.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
    expect(
      joins
        .filter((r) => r.status !== 200)
        .every((r) => r.status === 409 && ['TEAM_FULL', 'SEAT_TAKEN'].includes(r.code ?? '')),
    ).toBe(true);
    const members = await activeMemberships(world, f.id);
    expect(members).toBeLessThanOrEqual(8);
    expect((await teamRow(world, f.id)).member_count).toBe(members);
    expect(members).toBe(7 + joins.filter((r) => r.status === 200).length);
    // The seat of the leaver opens only after the leave has finished.
    expect(await seatStatus(world, leaverSeat.id)).toBe('open');
    expect(await activeAssignments(world, leaverSeat.id)).toBe(0);
  });

  it('12.3 (C-04): 20 parallel addSeats of one seat to a team of 11 seats -> one 201, nineteen 422 SEAT_LIMIT, 12 seats', async () => {
    const t = await team(world, { openSeats: 11 });
    const fired = await fireAll(N, (_i, key) =>
      world
        .as(t.lead)
        .post(`/v1/teams/${t.id}/seats`, { seats: [seatInput()] }, { idempotencyKey: key }),
    );
    expect(tally(fired)).toEqual({ 201: 1, 422: N - 1 });
    expect(codesAt(fired, 422)).toEqual(['SEAT_LIMIT']);
    expect((await teamRow(world, t.id)).seat_count).toBe(12);
    const winner = winnerOf(fired, 201);
    expectReplayOf(
      winner,
      await world
        .as(t.lead)
        .post(`/v1/teams/${t.id}/seats`, { seats: [seatInput()] }, { idempotencyKey: winner.key }),
    );
    expect((await teamRow(world, t.id)).seat_count).toBe(12);
  });

  it('12.1: every CC scenario at once on one team (joins, leaves, closes, additions, invitations, votes) -> no 5xx, no 40P01', async () => {
    const f = await teamWithOpenSeat(world, {
      members: 5,
      openSeats: 4,
      candidates: 4,
      status: 'active',
    });
    const extra = await manyGithubUsers(world, 'mixed', 4);
    const seat = f.openSeats[0];
    if (!seat) throw new Error('no seat');
    const calls: (() => Promise<InjectResponse>)[] = [
      ...f.candidates.map(
        (c, i) => () => world.as(c).post(`/v1/seat-offers/${f.offers[i]?.id}/acceptance`),
      ),
      ...f.members.slice(0, 2).map((m) => () => world.as(m).delete(`/v1/teams/${f.id}/members/me`)),
      ...f.openSeats
        .slice(1)
        .map((s) => () => world.as(f.lead).delete(`/v1/teams/${f.id}/seats/${s.id}`)),
      ...extra.map(
        (u) => () =>
          world.as(f.lead).post(`/v1/teams/${f.id}/seat-offers`, { seatId: seat.id, userId: u.id }),
      ),
      () => world.as(f.lead).post(`/v1/teams/${f.id}/invitations`, { seatId: seat.id }),
      () => world.as(f.lead).post(`/v1/teams/${f.id}/seats`, { seats: [seatInput()] }),
      () => world.as(f.members[2] ?? f.lead).post(`/v1/teams/${f.id}/leader-vote-requests`),
      () =>
        world.as(f.lead).patch(`/v1/teams/${f.id}`, { name: 'Busy team', version: f.dto.version }),
    ];
    const fired = await fireAll(calls.length, (i) => (calls[i] as () => Promise<InjectResponse>)());
    expect(
      fired.every((r) => r.status < 500),
      JSON.stringify(tally(fired)),
    ).toBe(true);
    const members = await activeMemberships(world, f.id);
    expect((await teamRow(world, f.id)).member_count).toBe(members);
    const dup = await world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (
        SELECT seat_id FROM teams.seat_assignment WHERE team_id = ${f.id} AND ended_at IS NULL
         GROUP BY seat_id HAVING count(*) > 1) d`;
    expect(dup[0]?.n).toBe(0);
  });
});
