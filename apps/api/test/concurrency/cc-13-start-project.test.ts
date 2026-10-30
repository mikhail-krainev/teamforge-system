import { afterAll, beforeAll, expect, it } from 'vitest';
import { codesAt, expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import { githubUser, joinThroughOffer, team, type TeamDto } from '../fixtures/teams.js';
import { eventCount, expectNoDeadlocks, teamRow } from '../fixtures/teams-db.js';
import { World } from '../fixtures/world.js';
import { describeInfra } from '../helpers/infra.js';

const N = 20;

describeInfra('CC-13 (start part): starting the project (FR-TEAM-10)', ['db', 'redis'], () => {
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

  it('CC-13: 20 "Start" requests (20 keys) -> one 200, nineteen 409 INVALID_STATE, one start in the journal', async () => {
    const t = await team(world, { members: 2, openSeats: 1 });
    const fired = await fireAll(N, (_i, key) =>
      world.as(t.lead).post(`/v1/teams/${t.id}/start`, undefined, { idempotencyKey: key }),
    );
    expect(tally(fired)).toEqual({ 200: 1, 409: N - 1 });
    expect(codesAt(fired, 409)).toEqual(['INVALID_STATE']);
    expect(await teamRow(world, t.id)).toMatchObject({ status: 'active' });
    expect(await eventCount(world, t.id, 'team_started')).toBe(1);
    const winner = winnerOf(fired, 200);
    const stored = winner.response.json<TeamDto>();
    expect(stored.status).toBe('active');
    const startedAt = await world.sql<
      { started_at: Date }[]
    >`SELECT started_at FROM teams.team WHERE id = ${t.id}`;
    expect(Date.parse(stored.startedAt ?? '')).toBe(startedAt[0]?.started_at.getTime());
  });

  it('CC-13 (replay): the winner repeats his key -> the stored 200; a loser -> the stored 409; the start stays single', async () => {
    const t = await team(world, { openSeats: 1 });
    const fired = await fireAll(N, (_i, key) =>
      world.as(t.lead).post(`/v1/teams/${t.id}/start`, undefined, { idempotencyKey: key }),
    );
    const winner = winnerOf(fired, 200);
    const loser = winnerOf(fired, 409);
    expectReplayOf(
      winner,
      await world
        .as(t.lead)
        .post(`/v1/teams/${t.id}/start`, undefined, { idempotencyKey: winner.key }),
    );
    expectReplayOf(
      loser,
      await world
        .as(t.lead)
        .post(`/v1/teams/${t.id}/start`, undefined, { idempotencyKey: loser.key }),
    );
    expect(await eventCount(world, t.id, 'team_started')).toBe(1);
  });

  it('CC-13: "Start" against joins of the open seat: the team ends active and each join has a single outcome', async () => {
    const t = await team(world, { openSeats: 5 });
    const candidates = await Promise.all(
      Array.from({ length: 5 }, (_, i) => githubUser(world, `cc13-join-${i}`)),
    );
    const offers = await Promise.all(
      candidates.map(
        async (c, i) =>
          (
            await world
              .as(t.lead)
              .post(`/v1/teams/${t.id}/seat-offers`, { seatId: t.openSeats[i]?.id, userId: c.id })
          ).json<{ id: string }>().id,
      ),
    );
    const fired = await fireAll(N, (i, key) =>
      i < 15
        ? world.as(t.lead).post(`/v1/teams/${t.id}/start`, undefined, { idempotencyKey: key })
        : world
            .as(candidates[i - 15] ?? t.lead)
            .post(`/v1/seat-offers/${offers[i - 15]}/acceptance`, undefined, {
              idempotencyKey: key,
            }),
    );
    expect(fired.filter((f) => f.index < 15 && f.status === 200)).toHaveLength(1);
    expect(fired.filter((f) => f.index >= 15).map((f) => f.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await teamRow(world, t.id)).toMatchObject({ status: 'active', member_count: 6 });
  });

  it('CC-13: a join through the normal path still works after the start (FR-TEAM-04 on an active team)', async () => {
    const t = await team(world, { status: 'active', openSeats: 1 });
    const seat = t.openSeats[0];
    if (!seat) throw new Error('no seat');
    const candidate = await githubUser(world, 'cc13-after');
    await joinThroughOffer(world, t.lead, t.id, seat.id, candidate);
    expect((await teamRow(world, t.id)).member_count).toBe(2);
  });
});
