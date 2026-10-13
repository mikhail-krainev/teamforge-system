import { afterAll, beforeAll, expect, it } from 'vitest';
import { codesAt, expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import { githubUser, team, teamWithOpenSeat } from '../fixtures/teams.js';
import { activeAssignments, expectNoDeadlocks, seatStatus, teamRow } from '../fixtures/teams-db.js';
import { World } from '../fixtures/world.js';
import { describeInfra } from '../helpers/infra.js';

const N = 20;

describeInfra('CC-1: taking a seat (FR-TEAM-04, -30)', ['db', 'redis'], () => {
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

  it('CC-1: 20 users with 20 different offers for one seat -> exactly one 200, nineteen 409 SEAT_TAKEN', async () => {
    const f = await teamWithOpenSeat(world, { candidates: N });
    const fired = await fireAll(N, (i, key) => {
      const user = f.candidates[i];
      const offer = f.offers[i];
      if (!user || !offer) throw new Error('fixture');
      return world
        .as(user)
        .post(`/v1/seat-offers/${offer.id}/acceptance`, undefined, { idempotencyKey: key });
    });
    expect(tally(fired)).toEqual({ 200: 1, 409: N - 1 });
    expect(codesAt(fired, 409)).toEqual(['SEAT_TAKEN']);
    expect(await activeAssignments(world, f.seat.id)).toBe(1);
    expect(await seatStatus(world, f.seat.id)).toBe('filled');
    expect(await teamRow(world, f.id)).toMatchObject({ member_count: 2 });
    const rows = await world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM teams.membership WHERE team_id = ${f.id} AND status = 'active'`;
    expect(rows[0]?.n).toBe(2);
  });

  it('CC-1 (replay): the winner repeats his key -> the stored 200, no second member; a loser repeats his key -> the stored 409', async () => {
    const f = await teamWithOpenSeat(world, { candidates: N });
    const fired = await fireAll(N, (i, key) =>
      world
        .as(f.candidates[i] ?? f.lead)
        .post(`/v1/seat-offers/${f.offers[i]?.id}/acceptance`, undefined, { idempotencyKey: key }),
    );
    const winner = winnerOf(fired, 200);
    const loser = winnerOf(fired, 409);
    const replayWin = await world
      .as(f.candidates[winner.index] ?? f.lead)
      .post(`/v1/seat-offers/${f.offers[winner.index]?.id}/acceptance`, undefined, {
        idempotencyKey: winner.key,
      });
    expectReplayOf(winner, replayWin);
    const replayLose = await world
      .as(f.candidates[loser.index] ?? f.lead)
      .post(`/v1/seat-offers/${f.offers[loser.index]?.id}/acceptance`, undefined, {
        idempotencyKey: loser.key,
      });
    expectReplayOf(loser, replayLose);
    expect(await activeAssignments(world, f.seat.id)).toBe(1);
    expect((await teamRow(world, f.id)).member_count).toBe(2);
  });

  it('CC-1 (variants): one seat claimed through offers, an invitation link and join requests at once -> still one winner', async () => {
    const f = await teamWithOpenSeat(world, { candidates: 7 });
    const inviteResponse = await world
      .as(f.lead)
      .post(`/v1/teams/${f.id}/invitations`, { seatId: f.seat.id });
    const token = inviteResponse.json<{ token: string }>().token;
    const invitees = await Promise.all(
      Array.from({ length: 7 }, (_, i) => githubUser(world, `cc1-invitee-${i}`)),
    );
    const requesters = await Promise.all(
      Array.from({ length: 6 }, (_, i) => githubUser(world, `cc1-requester-${i}`)),
    );
    const requests = await Promise.all(
      requesters.map(
        async (r) =>
          (await world.as(r).post(`/v1/teams/${f.id}/join-requests`, { seatId: f.seat.id })).json<{
            id: string;
          }>().id,
      ),
    );
    const fired = await fireAll(N, (i, key) => {
      if (i < 7)
        return world
          .as(f.candidates[i] ?? f.lead)
          .post(`/v1/seat-offers/${f.offers[i]?.id}/acceptance`, undefined, {
            idempotencyKey: key,
          });
      if (i < 14)
        return world
          .as(invitees[i - 7] ?? f.lead)
          .post('/v1/invitation-acceptances', { token }, { idempotencyKey: key });
      return world
        .as(f.lead)
        .post(`/v1/seat-offers/${requests[i - 14]}/acceptance`, undefined, { idempotencyKey: key });
    });
    expect(tally(fired)[200]).toBe(1);
    expect(await activeAssignments(world, f.seat.id)).toBe(1);
    expect((await teamRow(world, f.id)).member_count).toBe(2);
  });

  it('CC-1: the same user cannot take two seats of the same role (FR-TEAM-07): parallel acceptances give one win', async () => {
    const t = await team(world, { openSeats: 2, roleCode: 'qa' });
    const candidate = await githubUser(world, 'cc1-double');
    const offers = await Promise.all(
      t.openSeats.map(
        async (seat) =>
          (
            await world
              .as(t.lead)
              .post(`/v1/teams/${t.id}/seat-offers`, { seatId: seat.id, userId: candidate.id })
          ).json<{ id: string }>().id,
      ),
    );
    const fired = await fireAll(offers.length, (i, key) =>
      world
        .as(candidate)
        .post(`/v1/seat-offers/${offers[i]}/acceptance`, undefined, { idempotencyKey: key }),
    );
    expect(tally(fired)).toEqual({ 200: 1, 409: 1 });
    expect(codesAt(fired, 409)).toEqual(['ALREADY_MEMBER']);
    const rows = await world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM teams.seat_assignment WHERE team_id = ${t.id} AND user_id = ${candidate.id} AND ended_at IS NULL`;
    expect(rows[0]?.n).toBe(1);
  });
});
