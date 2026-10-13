import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { codesAt, expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import { ballot, currentVote, DAY, leaderVote, team, type VoteDto } from '../fixtures/teams.js';
import { eventCount, expectNoDeadlocks, openVotes, teamRow } from '../fixtures/teams-db.js';
import { World } from '../fixtures/world.js';
import { FakeClock } from '../helpers/clock.js';
import { barrier, describeInfra, waitFor } from '../helpers/infra.js';

const N = 20;
const HOUR = 3_600_000;

describeInfra('CC-4: the leader vote (FR-TEAM-14, -16, -17)', ['db', 'redis'], () => {
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

  it('CC-4(а): 20 identical ballots of one member (20 keys) -> one 201, nineteen 409 ALREADY_VOTED, one ballot row', async () => {
    const f = await leaderVote(world, { phase: 'voting' });
    const [b, c] = f.eligible;
    if (!b || !c) throw new Error('fixture');
    const url = `/v1/teams/${f.team.id}/leader-votes/${f.voteId}/ballots`;
    const fired = await fireAll(N, (_i, key) =>
      world.as(c).post(url, { candidateUserId: b.id }, { idempotencyKey: key }),
    );
    expect(tally(fired)).toEqual({ 201: 1, 409: N - 1 });
    expect(codesAt(fired, 409)).toEqual(['ALREADY_VOTED']);
    const rows = await world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM teams.vote_ballot WHERE vote_id = ${f.voteId} AND voter_user_id = ${c.id}`;
    expect(rows[0]?.n).toBe(1);
    const winner = winnerOf(fired, 201);
    expectReplayOf(
      winner,
      await world.as(c).post(url, { candidateUserId: b.id }, { idempotencyKey: winner.key }),
    );
    const loser = winnerOf(fired, 409);
    expectReplayOf(
      loser,
      await world.as(c).post(url, { candidateUserId: b.id }, { idempotencyKey: loser.key }),
    );
    expect((await currentVote(world, c, f.team.id)).ballotsCast).toBe(1);
  });

  it('CC-4(б): 20 parallel "the lead left" and "inactivity request" calls -> exactly one open vote', async () => {
    const t = await team(world, { members: 5, openSeats: 0, status: 'active' });
    clock.advance(15 * DAY);
    const requesters = t.members;
    const fired = await fireAll(N, (i, key) => {
      if (i < 8)
        return world.as(t.lead).delete(`/v1/teams/${t.id}/members/me`, { idempotencyKey: key });
      const requester = requesters[i % requesters.length] ?? t.lead;
      return world
        .as(requester)
        .post(`/v1/teams/${t.id}/leader-vote-requests`, undefined, { idempotencyKey: key });
    });
    expect(
      fired.every((f) => f.status < 500),
      JSON.stringify(tally(fired)),
    ).toBe(true);
    expect(await openVotes(world, t.id)).toBe(1);
    const all = await world.sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM teams.leader_vote WHERE team_id = ${t.id}`;
    expect(all[0]?.n).toBe(1);
    expect((await teamRow(world, t.id)).status).toBe('voting');
    const created = fired.find((f) => f.status === 204 || f.status === 201);
    if (!created) throw new Error('no successful call');
    const replay =
      created.index < 8
        ? await world
            .as(t.lead)
            .delete(`/v1/teams/${t.id}/members/me`, { idempotencyKey: created.key })
        : await world
            .as(requesters[created.index % requesters.length] ?? t.lead)
            .post(`/v1/teams/${t.id}/leader-vote-requests`, undefined, {
              idempotencyKey: created.key,
            });
    expectReplayOf(created, replay);
    expect(await openVotes(world, t.id)).toBe(1);
  });

  it('CC-4(б): 20 lead-leave calls with different keys -> one 204, the others are refused, one vote', async () => {
    const t = await team(world, { members: 4, openSeats: 0, status: 'active' });
    const fired = await fireAll(N, (_i, key) =>
      world.as(t.lead).delete(`/v1/teams/${t.id}/members/me`, { idempotencyKey: key }),
    );
    expect(tally(fired)[204]).toBe(1);
    expect(
      fired.filter((f) => f.status !== 204).every((f) => f.status === 404 || f.status === 409),
    ).toBe(true);
    expect(await openVotes(world, t.id)).toBe(1);
    expect(await eventCount(world, t.id, 'lead_changed')).toBe(0);
  });

  it('CC-4(в): the last ballot against the deadline handler (FakeClock) -> one lead_changed, one lead, one outcome', async () => {
    const f = await leaderVote(world, { phase: 'voting' });
    const [b, c, d] = f.eligible;
    if (!b || !c || !d) throw new Error('fixture');
    const url = `/v1/teams/${f.team.id}/leader-votes/${f.voteId}/ballots`;
    await ballot(world, f.team, f.voteId, b, b);
    clock.advance(48 * HOUR); // the 72 hours of the vote are over at this moment
    const gate = barrier(N);
    const keys = Array.from({ length: 10 }, () => randomUUID());
    const calls = await Promise.allSettled([
      ...keys.map(async (key) => {
        await gate.wait();
        return world.as(c).post(url, { candidateUserId: b.id }, { idempotencyKey: key });
      }),
      ...Array.from({ length: 10 }, async () => {
        await gate.wait();
        await world.runMaintenance('vote-deadline-scan');
        return undefined;
      }),
    ]);
    expect(calls.every((r) => r.status === 'fulfilled')).toBe(true);
    const accepted201 = calls.findIndex(
      (r, i) => i < 10 && r.status === 'fulfilled' && r.value?.statusCode === 201,
    );
    expect(accepted201, 'one ballot of c was accepted').toBeGreaterThanOrEqual(0);
    const replay = await world
      .as(c)
      .post(url, { candidateUserId: b.id }, { idempotencyKey: keys[accepted201] });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const settled = await waitFor(async () => {
      const vote = await currentVote(world, d, f.team.id);
      return vote.status === 'confirming' ? vote : false;
    }, 30_000);
    expect(settled.pendingOffer).toMatchObject({ userId: b.id, kind: 'winner_confirmation' });
    const accepted = await world
      .as(b)
      .post(`/v1/teams/${f.team.id}/leader-votes/${f.voteId}/offer-responses`, { accept: true });
    expect(accepted.statusCode).toBe(200);
    await world.runMaintenance('vote-deadline-scan');
    expect(await eventCount(world, f.team.id, 'lead_changed')).toBe(1);
    expect(await teamRow(world, f.team.id)).toMatchObject({ lead_user_id: b.id, status: 'active' });
    const outcomes = await world.sql<{ outcome: string | null }[]>`
      SELECT outcome FROM teams.leader_vote WHERE team_id = ${f.team.id} AND outcome IS NOT NULL`;
    expect(outcomes.map((o) => o.outcome)).toEqual(['elected']);
    const final: VoteDto = await currentVote(world, d, f.team.id);
    expect(final).toMatchObject({ status: 'closed', winnerUserId: b.id });
  });
});
