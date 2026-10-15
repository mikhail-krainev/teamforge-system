import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  codesAt,
  expectReplayOf,
  fireAll,
  tally,
  winnerOf,
  type Fired,
} from '../fixtures/concurrency.js';
import {
  currentVote,
  expectOk,
  githubUser,
  leaderVote,
  manyGithubUsers,
  team,
  teamWithOpenSeat,
  type InvitationDto,
  type OfferDto,
  type TeamDto,
} from '../fixtures/teams.js';
import {
  activeAssignments,
  activeInvitations,
  activeMemberships,
  activeMembershipsOf,
  eventCount,
  expectNoDeadlocks,
  invitationRow,
  openVotes,
  seatStatus,
  teamRow,
} from '../fixtures/teams-db.js';
import { World } from '../fixtures/world.js';
import { FakeClock } from '../helpers/clock.js';
import { describeInfra } from '../helpers/infra.js';

/**
 * S3-14: concurrent variants of the edge cases (docs/plan.md, "Тесты среза"). Every burst has at
 * least 20 requests; where the winner is not fixed the test asserts the invariant that must hold
 * for every order of execution.
 */
const N = 20;

describeInfra('S3-14: edge cases under concurrency', ['db', 'redis'], () => {
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

  const noServerErrors = (fired: Fired[]): void =>
    expect(
      fired.filter((f) => f.status >= 500).map((f) => `${f.status} ${f.code}`),
      JSON.stringify(tally(fired)),
    ).toEqual([]);

  it('repeated nomination: 20 nominations of one member (self and by others, 20 keys) -> one 201, nineteen 409 CANDIDATE_EXISTS, one row', async () => {
    const f = await leaderVote(world, { phase: 'nominating' });
    const [b, c, d] = f.eligible;
    if (!b || !c || !d) throw new Error('fixture');
    const url = `/v1/teams/${f.team.id}/leader-votes/${f.voteId}/candidates`;
    const nominators = [b, c, d];
    const fired = await fireAll(N, (i, key) =>
      world.as(nominators[i % 3] ?? b).post(url, { userId: b.id }, { idempotencyKey: key }),
    );
    expect(tally(fired)).toEqual({ 201: 1, 409: N - 1 });
    expect(codesAt(fired, 409)).toEqual(['CANDIDATE_EXISTS']);
    const rows = await world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM teams.vote_candidate WHERE vote_id = ${f.voteId} AND user_id = ${b.id}`;
    expect(rows[0]?.n).toBe(1);
    expect(await eventCount(world, f.team.id, 'candidate_nominated')).toBe(1);
    const winner = winnerOf(fired, 201);
    const actor = nominators[winner.index % 3] ?? b;
    expectReplayOf(
      winner,
      await world.as(actor).post(url, { userId: b.id }, { idempotencyKey: winner.key }),
    );
  });

  it('repeated withdrawal: 20 withdrawals of one candidate -> one 200, nineteen 409 INVALID_STATE', async () => {
    const f = await leaderVote(world, { phase: 'voting' });
    const b = f.eligible[0];
    if (!b) throw new Error('fixture');
    const url = `/v1/teams/${f.team.id}/leader-votes/${f.voteId}/candidates/me/withdrawal`;
    const fired = await fireAll(N, (_i, key) =>
      world.as(b).post(url, undefined, { idempotencyKey: key }),
    );
    expect(tally(fired)).toEqual({ 200: 1, 409: N - 1 });
    expect(codesAt(fired, 409)).toEqual(['INVALID_STATE']);
    expect(await eventCount(world, f.team.id, 'candidacy_withdrawn')).toBe(1);
  });

  it('ballot after a phase change: 15 ballots for a candidate against 5 withdrawals of his -> no 5xx, one ballot per voter, no lead is made', async () => {
    const f = await leaderVote(world, { phase: 'voting', members: 6 });
    const [b, c, d, e] = f.eligible;
    if (!b || !c || !d || !e) throw new Error('fixture');
    const voters = [c, d, e];
    const base = `/v1/teams/${f.team.id}/leader-votes/${f.voteId}`;
    const fired = await fireAll(N, (i, key) =>
      i < 15
        ? world
            .as(voters[i % 3] ?? c)
            .post(`${base}/ballots`, { candidateUserId: b.id }, { idempotencyKey: key })
        : world.as(b).post(`${base}/candidates/me/withdrawal`, undefined, { idempotencyKey: key }),
    );
    noServerErrors(fired);
    const ballots = fired.filter((f2) => f2.index < 15);
    const withdrawals = fired.filter((f2) => f2.index >= 15);
    expect(withdrawals.filter((w) => w.status === 200)).toHaveLength(1);
    expect(withdrawals.filter((w) => w.status !== 200).every((w) => w.status === 409)).toBe(true);
    const stored = await world.sql<{ voter_user_id: string; n: number }[]>`
      SELECT voter_user_id, count(*)::int AS n FROM teams.vote_ballot
       WHERE vote_id = ${f.voteId} GROUP BY voter_user_id`;
    expect(stored.every((r) => r.n === 1)).toBe(true);
    expect(stored).toHaveLength(ballots.filter((x) => x.status === 201).length);
    // refusals of a ballot are the documented ones
    for (const x of ballots.filter((y) => y.status !== 201)) {
      expect(['ALREADY_VOTED', 'INVALID_STATE', 'NOT_FOUND', 'VOTE_PHASE']).toContain(x.code);
    }
    // nobody confirmed anything: the team is still leaderless and the vote open
    expect(await openVotes(world, f.team.id)).toBe(1);
    expect(await eventCount(world, f.team.id, 'lead_changed')).toBe(0);
    expect((await teamRow(world, f.team.id)).lead_user_id).toBeNull();
  });

  it('leaving as a candidate: 10 leaves of the candidate against 10 ballots for him -> one 204, no 5xx, the vote ends consistent', async () => {
    const f = await leaderVote(world, { phase: 'voting', members: 6 });
    const [b, c, d, e] = f.eligible;
    if (!b || !c || !d || !e) throw new Error('fixture');
    const voters = [c, d, e];
    const fired = await fireAll(N, (i, key) =>
      i < 10
        ? world.as(b).delete(`/v1/teams/${f.team.id}/members/me`, { idempotencyKey: key })
        : world
            .as(voters[i % 3] ?? c)
            .post(
              `/v1/teams/${f.team.id}/leader-votes/${f.voteId}/ballots`,
              { candidateUserId: b.id },
              { idempotencyKey: key },
            ),
    );
    noServerErrors(fired);
    expect(fired.filter((x) => x.index < 10 && x.status === 204)).toHaveLength(1);
    expect(
      fired
        .filter((x) => x.index < 10 && x.status !== 204)
        .every((x) => x.status === 404 || x.status === 409),
    ).toBe(true);
    const vote = await currentVote(world, c, f.team.id);
    // Three ballots out of four voters are a majority. When the ballots came first, b was asked while
    // still a member and then left: the offer waits for its 24 hours (known limitation, see
    // src/modules/teams/test/edge-cases.test.ts). When b left first nobody asks him.
    if (vote.pendingOffer?.userId === b.id) expect(vote.status).toBe('confirming');
    else expect(['voting', 'offering']).toContain(vote.status);
    expect(await activeMembershipsOf(world, b.id)).toBe(0);
    expect((await teamRow(world, f.team.id)).lead_user_id).toBeNull();
  });

  it('the last member leaving: 20 leaves of a lone lead -> one 204, nineteen refused, the team is archived with member_count 0', async () => {
    const t = await team(world, { members: 1, openSeats: 2 });
    const fired = await fireAll(N, (_i, key) =>
      world.as(t.lead).delete(`/v1/teams/${t.id}/members/me`, { idempotencyKey: key }),
    );
    expect(tally(fired)[204]).toBe(1);
    expect(
      fired.filter((x) => x.status !== 204).every((x) => x.status === 404 || x.status === 409),
    ).toBe(true);
    expect(await teamRow(world, t.id)).toMatchObject({
      status: 'archived',
      member_count: 0,
      lead_user_id: null,
    });
    expect(await activeMemberships(world, t.id)).toBe(0);
    expect(await openVotes(world, t.id)).toBe(0);
    const winner = winnerOf(fired, 204);
    expectReplayOf(
      winner,
      await world.as(t.lead).delete(`/v1/teams/${t.id}/members/me`, { idempotencyKey: winner.key }),
    );
  });

  it('the last members leaving together: lead and one member, 10 leaves each -> the team ends archived, empty, with no open vote', async () => {
    const t = await team(world, { members: 2, openSeats: 0, status: 'active' });
    const member = t.members[0];
    if (!member) throw new Error('fixture');
    const fired = await fireAll(N, (i, key) =>
      world
        .as(i % 2 === 0 ? t.lead : member)
        .delete(`/v1/teams/${t.id}/members/me`, { idempotencyKey: key }),
    );
    noServerErrors(fired);
    expect(tally(fired)[204]).toBe(2);
    expect(await activeMemberships(world, t.id)).toBe(0);
    expect(await teamRow(world, t.id)).toMatchObject({ status: 'archived', member_count: 0 });
    expect(await openVotes(world, t.id)).toBe(0);
  });

  it('the last members leaving together: lead and two members, 20 leaves -> member_count 0 and the team does not stay in `voting` without members', async () => {
    const t = await team(world, { members: 3, openSeats: 0, status: 'active' });
    const people = [t.lead, ...t.members];
    const fired = await fireAll(N, (i, key) =>
      world
        .as(people[i % 3] ?? t.lead)
        .delete(`/v1/teams/${t.id}/members/me`, { idempotencyKey: key }),
    );
    noServerErrors(fired);
    expect(tally(fired)[204]).toBe(3);
    expect(await activeMemberships(world, t.id)).toBe(0);
    const row = await teamRow(world, t.id);
    expect(row.member_count).toBe(0);
    expect(row.status).toBe('archived');
    expect(await openVotes(world, t.id)).toBe(0);
  });

  it('an offer on a closed seat: 20 closings of a seat with pending offers -> one 204, then every pending offer is refused with SEAT_NOT_OPEN and cancelled', async () => {
    const f = await teamWithOpenSeat(world, { candidates: N });
    const closed = await fireAll(N, (_i, key) =>
      world.as(f.lead).delete(`/v1/teams/${f.id}/seats/${f.seat.id}`, { idempotencyKey: key }),
    );
    expect(tally(closed)).toEqual({ 204: 1, 409: N - 1 });
    expect(codesAt(closed, 409)).toEqual(['INVALID_STATE']);
    expect(await seatStatus(world, f.seat.id)).toBe('closed');
    const accepted = await fireAll(N, (i, key) =>
      world
        .as(f.candidates[i] ?? f.lead)
        .post(`/v1/seat-offers/${f.offers[i]?.id}/acceptance`, undefined, { idempotencyKey: key }),
    );
    expect(tally(accepted)).toEqual({ 409: N });
    expect(codesAt(accepted, 409)).toEqual(['SEAT_NOT_OPEN']);
    expect(await activeAssignments(world, f.seat.id)).toBe(0);
    expect((await teamRow(world, f.id)).member_count).toBe(1);
    const cancelled = await world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM teams.seat_offer WHERE seat_id = ${f.seat.id} AND status = 'cancelled'`;
    expect(cancelled[0]?.n).toBe(N);
  });

  it('an offer on a seat that is closed meanwhile: 10 acceptances against 10 closings -> the seat has one outcome, never filled and closed', async () => {
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
    noServerErrors(fired);
    const joined = fired.filter((x) => x.index < 10 && x.status === 200).length;
    const closedNow = fired.filter((x) => x.index >= 10 && x.status === 204).length;
    expect(joined + closedNow).toBe(1);
    expect(await seatStatus(world, f.seat.id)).toBe(joined === 1 ? 'filled' : 'closed');
    expect(await activeAssignments(world, f.seat.id)).toBe(joined);
    expect((await teamRow(world, f.id)).member_count).toBe(1 + joined);
  });

  it('a second role: 21 acceptances of 3 offers of one user for 3 roles -> exactly two seats, the third is ROLE_LIMIT, one member, one project (C-03)', async () => {
    const t = await team(world, { members: 1, openSeats: 3 });
    const user = await githubUser(world, 'three-roles');
    const offers: OfferDto[] = [];
    for (const seat of t.openSeats) {
      offers.push(
        expectOk<OfferDto>(
          'createSeatOffer',
          await world
            .as(t.lead)
            .post(`/v1/teams/${t.id}/seat-offers`, { seatId: seat.id, userId: user.id }),
          201,
        ),
      );
    }
    expect(new Set(t.openSeats.map((s) => s.roleCode)).size).toBe(3);
    const fired = await fireAll(21, (i, key) =>
      world.as(user).post(`/v1/seat-offers/${offers[i % 3]?.id}/acceptance`, undefined, {
        idempotencyKey: key,
      }),
    );
    noServerErrors(fired);
    expect(tally(fired)[200]).toBe(2);
    expect(codesAt(fired, 409).every((c) => c === 'ROLE_LIMIT' || c === 'INVALID_STATE')).toBe(
      true,
    );
    expect(fired.filter((x) => x.code === 'ROLE_LIMIT').length).toBeGreaterThanOrEqual(1);
    const held = await world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM teams.seat_assignment
       WHERE team_id = ${t.id} AND user_id = ${user.id} AND ended_at IS NULL`;
    expect(held[0]?.n).toBe(2);
    expect(await activeMemberships(world, t.id)).toBe(2);
    expect((await teamRow(world, t.id)).member_count).toBe(2);
    expect(await activeMembershipsOf(world, user.id)).toBe(1);
    const dto = expectOk<TeamDto>('getTeam', await world.as(t.lead).get(`/v1/teams/${t.id}`), 200);
    expect(dto.members.find((m) => m.userId === user.id)?.roles).toHaveLength(2);
    expect(dto.seats.filter((s) => s.status === 'open')).toHaveLength(1);
  });

  it('a second role against the project limit: a user in one project takes roles of team A and a seat of team B at once -> never more than 2 projects and 2 roles per team', async () => {
    const home = await team(world, { members: 1, openSeats: 1 });
    const user = home.lead;
    const a = await team(world, { members: 1, openSeats: 2 });
    const b = await team(world, { members: 1, openSeats: 1 });
    const offerFor = async (t: { id: string; lead: typeof user }, seatId: string) =>
      expectOk<OfferDto>(
        'createSeatOffer',
        await world.as(t.lead).post(`/v1/teams/${t.id}/seat-offers`, { seatId, userId: user.id }),
        201,
      );
    const seatA1 = a.openSeats[0];
    const seatA2 = a.openSeats[1];
    const seatB = b.openSeats[0];
    if (!seatA1 || !seatA2 || !seatB) throw new Error('seats');
    const offers = [
      await offerFor(a, seatA1.id),
      await offerFor(a, seatA2.id),
      await offerFor(b, seatB.id),
    ];
    const fired = await fireAll(N, (i, key) =>
      world.as(user).post(`/v1/seat-offers/${offers[i % 3]?.id}/acceptance`, undefined, {
        idempotencyKey: key,
      }),
    );
    noServerErrors(fired);
    expect(await activeMembershipsOf(world, user.id)).toBeLessThanOrEqual(2);
    expect(
      (await activeMemberships(world, a.id)) + (await activeMemberships(world, b.id)),
    ).toBeGreaterThanOrEqual(3);
    const rows = await world.sql<{ team_id: string; n: number }[]>`
      SELECT team_id, count(*)::int AS n FROM teams.membership
       WHERE user_id = ${user.id} AND status = 'active' GROUP BY team_id`;
    expect(rows.every((r) => r.n === 1)).toBe(true);
    expect(
      codesAt(fired, 409).every((c) =>
        ['PROJECT_LIMIT', 'INVALID_STATE', 'SEAT_NOT_OPEN'].includes(c),
      ),
    ).toBe(true);
  });

  it('invitation reuse after revoke: 20 acceptances of a revoked token -> twenty 410, no member; a new invitation for the seat still works', async () => {
    const t = await team(world, { openSeats: 1 });
    const seat = t.openSeats[0];
    if (!seat) throw new Error('seat');
    const created = expectOk<{ token: string; invitation: InvitationDto }>(
      'createInvitation',
      await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }),
      201,
    );
    expectOk(
      'revokeInvitation',
      await world.as(t.lead).delete(`/v1/teams/${t.id}/invitations/${created.invitation.id}`),
      204,
    );
    const users = await manyGithubUsers(world, 'revoked-burst', N);
    const fired = await fireAll(N, (i, key) =>
      world
        .as(users[i] ?? t.lead)
        .post('/v1/invitation-acceptances', { token: created.token }, { idempotencyKey: key }),
    );
    expect(tally(fired)).toEqual({ 410: N });
    expect(codesAt(fired, 410)).toEqual(['INVITATION_GONE']);
    expect(await activeMemberships(world, t.id)).toBe(1);
    expect(await seatStatus(world, seat.id)).toBe('open');
    const again = expectOk<{ token: string }>(
      'createInvitation',
      await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }),
      201,
    );
    const first = users[0];
    if (!first) throw new Error('users');
    expectOk(
      'acceptInvitation',
      await world.as(first).post('/v1/invitation-acceptances', { token: again.token }),
      200,
    );
  });

  it('revoking against accepting: 10 revokes and 10 acceptances of one invitation -> exactly one of them wins and the row agrees', async () => {
    const t = await team(world, { openSeats: 1 });
    const seat = t.openSeats[0];
    if (!seat) throw new Error('seat');
    const created = expectOk<{ token: string; invitation: InvitationDto }>(
      'createInvitation',
      await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }),
      201,
    );
    const users = await manyGithubUsers(world, 'revoke-race', 10);
    const fired = await fireAll(N, (i, key) =>
      i < 10
        ? world.as(t.lead).delete(`/v1/teams/${t.id}/invitations/${created.invitation.id}`, {
            idempotencyKey: key,
          })
        : world
            .as(users[i - 10] ?? t.lead)
            .post('/v1/invitation-acceptances', { token: created.token }, { idempotencyKey: key }),
    );
    noServerErrors(fired);
    const revoked = fired.filter((x) => x.index < 10 && x.status === 204).length;
    const accepted = fired.filter((x) => x.index >= 10 && x.status === 200).length;
    expect(revoked + accepted).toBe(1);
    expect(
      fired.filter((x) => x.index < 10 && x.status !== 204).every((x) => x.status === 409),
    ).toBe(true);
    expect(
      fired.filter((x) => x.index >= 10 && x.status !== 200).every((x) => x.status === 410),
    ).toBe(true);
    expect((await invitationRow(world, created.invitation.id))?.status).toBe(
      accepted === 1 ? 'used' : 'revoked',
    );
    expect(await activeMemberships(world, t.id)).toBe(1 + accepted);
    expect(await activeInvitations(world, t.id)).toBe(0);
  });

  it('starting against the lead leaving: 10 starts and 10 leaves of the lead of a forming team -> the team is `voting`, started at most once, the status before the vote matches', async () => {
    const t = await team(world, { members: 4, openSeats: 1 });
    const fired = await fireAll(N, (i, key) =>
      i < 10
        ? world.as(t.lead).post(`/v1/teams/${t.id}/start`, undefined, { idempotencyKey: key })
        : world.as(t.lead).delete(`/v1/teams/${t.id}/members/me`, { idempotencyKey: key }),
    );
    noServerErrors(fired);
    const started = fired.filter((x) => x.index < 10 && x.status === 200).length;
    expect(started).toBeLessThanOrEqual(1);
    expect(fired.filter((x) => x.index >= 10 && x.status === 204)).toHaveLength(1);
    for (const x of fired.filter((y) => y.index < 10 && y.status !== 200)) {
      expect([403, 404, 409]).toContain(x.status);
      expect([
        'NOT_TEAM_LEAD',
        'NOT_FOUND',
        'INVALID_STATE',
        'TEAM_STATUS_BLOCKS_ACTION',
      ]).toContain(x.code);
    }
    const row = await world.sql<{ status: string; before: string | null }[]>`
      SELECT status, status_before_vote AS before FROM teams.team WHERE id = ${t.id}`;
    expect(row[0]?.status).toBe('voting');
    expect(row[0]?.before).toBe(started === 1 ? 'active' : 'forming');
    expect(await eventCount(world, t.id, 'team_started')).toBe(started);
    expect(await openVotes(world, t.id)).toBe(1);
  });

  it('an account deletion during joining: 1 deletion request and 19 acceptances of the same offer -> the account is deleting and the seat is consistent with the winner', async () => {
    const f = await teamWithOpenSeat(world, { candidates: 1 });
    const candidate = f.candidates[0];
    const offer = f.offers[0];
    if (!candidate || !offer) throw new Error('fixture');
    const fired = await fireAll(N, (i, key) =>
      i === 0
        ? world
            .as(candidate)
            .post(
              '/v1/me/deletion-requests',
              { reason: 'user_request', confirm: true },
              { idempotencyKey: key },
            )
        : world
            .as(candidate)
            .post(`/v1/seat-offers/${offer.id}/acceptance`, undefined, { idempotencyKey: key }),
    );
    noServerErrors(fired);
    expect(fired[0]?.status).toBe(202);
    const accepted = fired.filter((x) => x.index > 0 && x.status === 200).length;
    expect(accepted).toBeLessThanOrEqual(1);
    const refusals = fired.filter((x) => x.index > 0 && x.status !== 200);
    for (const x of refusals) expect([401, 403, 409]).toContain(x.status);
    expect(
      refusals.some(
        (x) =>
          x.code === 'USER_INACTIVE' ||
          x.code === 'INVALID_STATE' ||
          x.status === 401 ||
          x.status === 403,
      ),
    ).toBe(true);
    const status = await world.sql<
      { status: string }[]
    >`SELECT status FROM auth."user" WHERE id = ${candidate.id}`;
    expect(status[0]?.status).toBe('deleting');
    expect(await activeAssignments(world, f.seat.id)).toBe(accepted);
    expect(await seatStatus(world, f.seat.id)).toBe(accepted === 1 ? 'filled' : 'open');
    expect((await teamRow(world, f.id)).member_count).toBe(1 + accepted);
    // after the request the account is out of every joining path
    const late = await world.as(candidate).post(`/v1/seat-offers/${offer.id}/acceptance`);
    expect([401, 403, 409]).toContain(late.statusCode);
  });

  it('an account deletion during joining: 10 users each accept an invitation while requesting the deletion of their account -> a member is either active at the join or joined before the request', async () => {
    const t = await team(world, { members: 1, openSeats: 10 });
    const people = await manyGithubUsers(world, 'del-join', 10);
    const invitations: { token: string }[] = [];
    for (const seat of t.openSeats) {
      invitations.push(
        expectOk<{ token: string }>(
          'createInvitation',
          await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }),
          201,
        ),
      );
    }
    const fired = await fireAll(N, (i, key) => {
      const person = people[i % 10];
      if (!person) throw new Error('person');
      return i < 10
        ? world
            .as(person)
            .post(
              '/v1/invitation-acceptances',
              { token: invitations[i]?.token },
              { idempotencyKey: key },
            )
        : world
            .as(person)
            .post(
              '/v1/me/deletion-requests',
              { reason: 'user_request', confirm: true },
              { idempotencyKey: key },
            );
    });
    noServerErrors(fired);
    const joined = fired.filter((x) => x.index < 10 && x.status === 200).length;
    for (const x of fired.filter((y) => y.index < 10 && y.status !== 200)) {
      expect([401, 403, 409]).toContain(x.status);
    }
    expect(fired.filter((x) => x.index >= 10).every((x) => x.status === 202)).toBe(true);
    const deleting = await world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM auth."user"
       WHERE status = 'deleting' AND id IN ${world.sql(people.map((p) => p.id))}`;
    expect(deleting[0]?.n).toBe(10);
    const members = await activeMemberships(world, t.id);
    expect(members).toBe(1 + joined);
    expect((await teamRow(world, t.id)).member_count).toBe(members);
    // a join that came after the request would show as a member without a successful 200
    const rows = await world.sql<{ user_id: string }[]>`
      SELECT user_id FROM teams.membership WHERE team_id = ${t.id} AND status = 'active' AND user_id <> ${t.lead.id}`;
    const okIds = new Set(
      fired.filter((x) => x.index < 10 && x.status === 200).map((x) => people[x.index]?.id),
    );
    expect(rows.every((r) => okIds.has(r.user_id))).toBe(true);
  });
});
