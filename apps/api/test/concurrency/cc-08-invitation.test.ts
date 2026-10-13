import { afterAll, beforeAll, expect, it } from 'vitest';
import { codesAt, expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import { expectOk, manyGithubUsers, team } from '../fixtures/teams.js';
import {
  activeAssignments,
  expectNoDeadlocks,
  invitationRow,
  teamRow,
} from '../fixtures/teams-db.js';
import { World } from '../fixtures/world.js';
import { describeInfra } from '../helpers/infra.js';

const N = 20;

describeInfra('CC-8: one invitation token, many takers (FR-TEAM-09)', ['db', 'redis'], () => {
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

  it('CC-8: 20 users accept one token -> one 200, nineteen 410 INVITATION_GONE, one used_by', async () => {
    const t = await team(world, { openSeats: 1 });
    const seat = t.openSeats[0];
    if (!seat) throw new Error('no seat');
    const created = expectOk<{ invitation: { id: string }; token: string }>(
      'createInvitation',
      await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }),
      201,
    );
    const users = await manyGithubUsers(world, 'cc8', N);
    const fired = await fireAll(N, (i, key) =>
      world
        .as(users[i] ?? t.lead)
        .post('/v1/invitation-acceptances', { token: created.token }, { idempotencyKey: key }),
    );
    expect(tally(fired)).toEqual({ 200: 1, 410: N - 1 });
    expect(codesAt(fired, 410)).toEqual(['INVITATION_GONE']);
    const winner = winnerOf(fired, 200);
    const row = await invitationRow(world, created.invitation.id);
    expect(row).toMatchObject({ status: 'used', used_by: users[winner.index]?.id });
    expect(await activeAssignments(world, seat.id)).toBe(1);
    expect((await teamRow(world, t.id)).member_count).toBe(2);
    const usedBy = await world.sql<{ n: number }[]>`
      SELECT count(DISTINCT used_by)::int AS n FROM teams.invitation WHERE id = ${created.invitation.id}`;
    expect(usedBy[0]?.n).toBe(1);
  });

  it('CC-8 (replay): the winner repeats his key -> the stored 200; a loser repeats his -> the stored 410', async () => {
    const t = await team(world, { openSeats: 1 });
    const seat = t.openSeats[0];
    if (!seat) throw new Error('no seat');
    const created = expectOk<{ token: string }>(
      'createInvitation',
      await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }),
      201,
    );
    const users = await manyGithubUsers(world, 'cc8r', N);
    const fired = await fireAll(N, (i, key) =>
      world
        .as(users[i] ?? t.lead)
        .post('/v1/invitation-acceptances', { token: created.token }, { idempotencyKey: key }),
    );
    const winner = winnerOf(fired, 200);
    const loser = winnerOf(fired, 410);
    expectReplayOf(
      winner,
      await world
        .as(users[winner.index] ?? t.lead)
        .post(
          '/v1/invitation-acceptances',
          { token: created.token },
          { idempotencyKey: winner.key },
        ),
    );
    expectReplayOf(
      loser,
      await world
        .as(users[loser.index] ?? t.lead)
        .post(
          '/v1/invitation-acceptances',
          { token: created.token },
          { idempotencyKey: loser.key },
        ),
    );
    expect(await activeAssignments(world, seat.id)).toBe(1);
  });

  it('CC-8: 20 invitations of one seat taken together by 20 users still fill the seat once (CC-1 behind CC-8)', async () => {
    const t = await team(world, { openSeats: 1 });
    const seat = t.openSeats[0];
    if (!seat) throw new Error('no seat');
    const tokens: string[] = [];
    for (let i = 0; i < N; i += 1) {
      const created = expectOk<{ token: string }>(
        'createInvitation',
        await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }),
        201,
      );
      tokens.push(created.token);
    }
    const users = await manyGithubUsers(world, 'cc8s', N);
    const fired = await fireAll(N, (i, key) =>
      world
        .as(users[i] ?? t.lead)
        .post('/v1/invitation-acceptances', { token: tokens[i] }, { idempotencyKey: key }),
    );
    expect(tally(fired)).toEqual({ 200: 1, 409: N - 1 });
    expect(codesAt(fired, 409)).toEqual(['SEAT_TAKEN']);
    expect(await activeAssignments(world, seat.id)).toBe(1);
  });
});
