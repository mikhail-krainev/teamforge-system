import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import {
  currentVote,
  expectOk,
  githubUser,
  leaderVote,
  passDeadline,
  team,
  type DepartureDto,
  type InvitationDto,
  type LeaderVoteFixture,
  type OfferDto,
} from '../../../../test/fixtures/teams.js';
import {
  activeMembershipsOf,
  activeMemberships,
  openVotes,
  seatStatus,
  teamRow,
} from '../../../../test/fixtures/teams-db.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

/**
 * S3-14: edge cases that the per-operation files do not reach (docs/plan.md, "Дополнение тестов").
 * The concurrent variants live in apps/api/test/concurrency/edge-cases.test.ts.
 */
describeInfra('S3 teams: edge cases (S3-14)', ['db', 'redis'], () => {
  let world: World;
  const clock = new FakeClock(Date.now());

  beforeAll(async () => {
    world = await startWorld({ clock });
  });

  afterAll(async () => {
    if (!world) return;
    await world.close();
  });

  const voteBase = (f: LeaderVoteFixture) => `/v1/teams/${f.team.id}/leader-votes/${f.voteId}`;
  const eligibleAt = (f: LeaderVoteFixture, i: number): UserFixture => {
    const m = f.eligible[i];
    if (!m) throw new Error(`no eligible member ${i}`);
    return m;
  };

  describe('repeated nomination and candidacy (FR-TEAM-15, -16)', () => {
    it('FR-TEAM-15: a withdrawn candidate cannot be nominated again, by himself or by another -> 409 CANDIDATE_EXISTS', async () => {
      const f = await leaderVote(world, { phase: 'nominating' });
      const [b, c] = [eligibleAt(f, 0), eligibleAt(f, 1)];
      const url = `${voteBase(f)}/candidates`;
      expectOk('nominateCandidate', await world.as(b).post(url, { userId: b.id }), 201);
      expectOk('withdrawCandidacy', await world.as(b).post(`${url}/me/withdrawal`), 200);
      expectProblem(
        'nominateCandidate',
        await world.as(b).post(url, { userId: b.id }),
        409,
        'CANDIDATE_EXISTS',
      );
      expectProblem(
        'nominateCandidate',
        await world.as(c).post(url, { userId: b.id }),
        409,
        'CANDIDATE_EXISTS',
      );
      const vote = await currentVote(world, c, f.team.id);
      expect(vote.candidates.filter((x) => x.userId === b.id)).toHaveLength(1);
    });

    it('FR-TEAM-15: the consent is idempotent (a repeat -> 200, one journal entry); after a withdrawal -> 409 INVALID_STATE', async () => {
      const f = await leaderVote(world, { phase: 'nominating' });
      const b = eligibleAt(f, 0);
      const url = `${voteBase(f)}/candidates`;
      expectOk('nominateCandidate', await world.as(b).post(url, { userId: b.id }), 201);
      expectOk('consentCandidacy', await world.as(b).post(`${url}/${b.id}/consent`), 200);
      expectOk('consentCandidacy', await world.as(b).post(`${url}/${b.id}/consent`), 200);
      const confirmed = await world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM teams.team_event
         WHERE team_id = ${f.team.id} AND type = 'candidacy_confirmed'`;
      expect(confirmed[0]?.n).toBe(1);
      expectOk('withdrawCandidacy', await world.as(b).post(`${url}/me/withdrawal`), 200);
      expectProblem(
        'consentCandidacy',
        await world.as(b).post(`${url}/${b.id}/consent`),
        409,
        'INVALID_STATE',
      );
    });

    it('FR-TEAM-15: nominating after the nomination period is over, in the voting phase -> 409 VOTE_PHASE (nobody is added)', async () => {
      const f = await leaderVote(world, { phase: 'voting' });
      const c = eligibleAt(f, 1);
      expectProblem(
        'nominateCandidate',
        await world.as(c).post(`${voteBase(f)}/candidates`, { userId: c.id }),
        409,
        'VOTE_PHASE',
      );
      expect((await currentVote(world, c, f.team.id)).candidates).toHaveLength(1);
    });
  });

  describe('a ballot after a phase change (FR-TEAM-16, -17, -19)', () => {
    it('FR-TEAM-17: after the majority moved the vote to confirming, a late ballot -> 409 VOTE_PHASE and is not stored', async () => {
      const f = await leaderVote(world, { phase: 'confirming' });
      const late = eligibleAt(f, 2);
      expectProblem(
        'castBallot',
        await world
          .as(late)
          .post(`${voteBase(f)}/ballots`, { candidateUserId: eligibleAt(f, 0).id }),
        409,
        'VOTE_PHASE',
      );
      const rows = await world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM teams.vote_ballot WHERE vote_id = ${f.voteId}`;
      expect(rows[0]?.n).toBe(2);
    });

    it('FR-TEAM-20: a ballot in the offering phase (nobody was nominated) -> 409 VOTE_PHASE', async () => {
      const f = await leaderVote(world, { phase: 'offering' });
      const [b, c] = [eligibleAt(f, 0), eligibleAt(f, 1)];
      expectProblem(
        'castBallot',
        await world.as(c).post(`${voteBase(f)}/ballots`, { candidateUserId: b.id }),
        409,
        'VOTE_PHASE',
      );
    });

    it('FR-TEAM-16: a ballot for a candidate who withdrew meanwhile -> 404; the earlier ballot of another voter stays', async () => {
      const f = await leaderVote(world, { phase: 'voting' });
      const [b, c, d] = [eligibleAt(f, 0), eligibleAt(f, 1), eligibleAt(f, 2)];
      const url = `${voteBase(f)}/ballots`;
      // eligible = 3, so one ballot is not yet a majority (> 1.5)
      expectOk('castBallot', await world.as(c).post(url, { candidateUserId: b.id }), 201);
      expectOk(
        'withdrawCandidacy',
        await world.as(b).post(`${voteBase(f)}/candidates/me/withdrawal`),
        200,
      );
      expectProblem(
        'castBallot',
        await world.as(d).post(url, { candidateUserId: b.id }),
        404,
        'NOT_FOUND',
      );
      expect((await currentVote(world, d, f.team.id)).ballotsCast).toBe(1);
    });

    it('FR-TEAM-19: in the runoff a voter of round 1 votes again, only for a runoff candidate', async () => {
      const f = await leaderVote(world, { phase: 'runoff' });
      expect(f.vote).toMatchObject({ status: 'runoff', round: 2 });
      const [b, c] = [eligibleAt(f, 0), eligibleAt(f, 1)];
      const voter = eligibleAt(f, 2);
      expectOk(
        'castBallot',
        await world.as(voter).post(`${voteBase(f)}/ballots`, { candidateUserId: c.id }),
        201,
      );
      expectProblem(
        'castBallot',
        await world.as(voter).post(`${voteBase(f)}/ballots`, { candidateUserId: b.id }),
        409,
        'ALREADY_VOTED',
      );
      const rounds = await world.sql<{ round: number; n: number }[]>`
        SELECT round, count(*)::int AS n FROM teams.vote_ballot
         WHERE vote_id = ${f.voteId} AND voter_user_id = ${voter.id} GROUP BY round ORDER BY round`;
      expect(rounds).toEqual([
        { round: 1, n: 1 },
        { round: 2, n: 1 },
      ]);
    });

    it('FR-TEAM-16: a voter who left the team after the vote opened cannot vote any more (403/404), his earlier ballot stays', async () => {
      const f = await leaderVote(world, { phase: 'voting', members: 5 });
      const [b, c, d] = [eligibleAt(f, 0), eligibleAt(f, 1), eligibleAt(f, 2)];
      const url = `${voteBase(f)}/ballots`;
      expectOk('castBallot', await world.as(c).post(url, { candidateUserId: b.id }), 201);
      expect((await world.as(c).delete(`/v1/teams/${f.team.id}/members/me`)).statusCode).toBe(204);
      const afterLeave = await world.as(c).post(url, { candidateUserId: b.id });
      expect([403, 404], afterLeave.body).toContain(afterLeave.statusCode);
      expect((await currentVote(world, d, f.team.id)).ballotsCast).toBe(1);
    });
  });

  describe('leaving: the last member and candidates (FR-TEAM-11, -14, -20)', () => {
    it('FR-TEAM-14: the last member leaves: the team is archived, off the catalog and nothing can join it any more', async () => {
      const t = await team(world, { members: 1, openSeats: 2 });
      const [seatA, seatB] = t.openSeats;
      if (!seatA || !seatB) throw new Error('seats');
      const candidate = await githubUser(world, 'last-offer');
      const invitee = await githubUser(world, 'last-invitee');
      const offer = expectOk<OfferDto>(
        'createSeatOffer',
        await world
          .as(t.lead)
          .post(`/v1/teams/${t.id}/seat-offers`, { seatId: seatA.id, userId: candidate.id }),
        201,
      );
      const invitation = expectOk<{ token: string }>(
        'createInvitation',
        await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, { seatId: seatB.id }),
        201,
      );
      expectOk('leaveTeam', await world.as(t.lead).delete(`/v1/teams/${t.id}/members/me`), 204);
      expect(await teamRow(world, t.id)).toMatchObject({
        status: 'archived',
        member_count: 0,
        lead_user_id: null,
      });
      expect(await activeMemberships(world, t.id)).toBe(0);
      expect(await openVotes(world, t.id)).toBe(0);
      expectProblem(
        'acceptSeatOffer',
        await world.as(candidate).post(`/v1/seat-offers/${offer.id}/acceptance`),
        409,
        'INVALID_STATE',
      );
      expectProblem(
        'acceptInvitation',
        await world.as(invitee).post('/v1/invitation-acceptances', { token: invitation.token }),
        409,
        'INVALID_STATE',
      );
      expect(await seatStatus(world, seatA.id)).toBe('open');
      const catalog = expectOk<{ items: { id: string }[] }>(
        'listTeams',
        await world.as(invitee).get('/v1/teams?limit=100'),
        200,
      );
      expect(catalog.items.map((i) => i.id)).not.toContain(t.id);
      // the lead is free again: his project slot is released
      expect(await activeMembershipsOf(world, t.lead.id)).toBe(0);
    });

    it('FR-TEAM-14: lead and one member: the lead leaves (the member leads), then the member leaves -> archived, no vote', async () => {
      const t = await team(world, { members: 2, openSeats: 0, status: 'active' });
      const member = t.members[0];
      if (!member) throw new Error('member');
      expectOk('leaveTeam', await world.as(t.lead).delete(`/v1/teams/${t.id}/members/me`), 204);
      expect(await teamRow(world, t.id)).toMatchObject({
        status: 'active',
        lead_user_id: member.id,
      });
      expectOk('leaveTeam', await world.as(member).delete(`/v1/teams/${t.id}/members/me`), 204);
      expect(await teamRow(world, t.id)).toMatchObject({ status: 'archived', member_count: 0 });
      expect(await openVotes(world, t.id)).toBe(0);
      // nobody is left to decide departures or to read the team any more
      expect((await world.as(member).get(`/v1/teams/${t.id}/departures`)).statusCode).toBe(404);
    });

    it('FR-TEAM-14: the lead leaves and then everybody who was asked to vote leaves too: nobody is left, so the team is archived and the vote is closed', async () => {
      const t = await team(world, { members: 3, openSeats: 0, status: 'active' });
      expectOk('leaveTeam', await world.as(t.lead).delete(`/v1/teams/${t.id}/members/me`), 204);
      expect(await teamRow(world, t.id)).toMatchObject({ status: 'voting', member_count: 2 });
      for (const m of t.members) {
        expectOk('leaveTeam', await world.as(m).delete(`/v1/teams/${t.id}/members/me`), 204);
      }
      expect(await activeMemberships(world, t.id)).toBe(0);
      expect(await teamRow(world, t.id)).toMatchObject({ status: 'archived', member_count: 0 });
      expect(await openVotes(world, t.id)).toBe(0);
    });

    it('FR-TEAM-11: the last non-lead member leaves: the lead stays alone and the team keeps its status; the seat opens', async () => {
      const t = await team(world, { members: 2, openSeats: 0 });
      const member = t.members[0];
      const seat = t.seats.find((s) => s.holderUserId === member?.id);
      if (!member || !seat) throw new Error('fixture');
      expectOk('leaveTeam', await world.as(member).delete(`/v1/teams/${t.id}/members/me`), 204);
      expect(await teamRow(world, t.id)).toMatchObject({
        status: 'forming',
        member_count: 1,
        lead_user_id: t.lead.id,
      });
      expect(await seatStatus(world, seat.id)).toBe('open');
      const departures = expectOk<{ items: DepartureDto[] }>(
        'listDepartures',
        await world.as(t.lead).get(`/v1/teams/${t.id}/departures`),
        200,
      );
      expect(departures.items).toHaveLength(1);
    });

    it('FR-TEAM-20 (known limitation): the winner who is asked to confirm leaves the team: the offer stays pending until its 24 hours pass', async () => {
      const f = await leaderVote(world, { phase: 'confirming' });
      const [b, c] = [eligibleAt(f, 0), eligibleAt(f, 1)];
      expect(f.vote.pendingOffer).toMatchObject({ userId: b.id, kind: 'winner_confirmation' });
      expect((await world.as(b).delete(`/v1/teams/${f.team.id}/members/me`)).statusCode).toBe(204);
      // Actual behavior: nothing re-asks on leaving; the vote is not advanced and waits for the deadline.
      const waiting = await currentVote(world, c, f.team.id);
      expect(waiting.status).toBe('confirming');
      expect(waiting.pendingOffer).toMatchObject({ userId: b.id, kind: 'winner_confirmation' });
      // The leaver cannot accept the lead role without being a member.
      expectProblem(
        'respondLeaderOffer',
        await world.as(b).post(`${voteBase(f)}/offer-responses`, { accept: true }),
        403,
        'NOT_ELIGIBLE',
      );
      expect((await currentVote(world, c, f.team.id)).status).toBe('confirming');
      // The team is still leaderless and voting meanwhile.
      expect(await teamRow(world, f.team.id)).toMatchObject({
        status: 'voting',
        lead_user_id: null,
      });
      // After the 24 hours the offer lapses and the vote moves on to the senior member, who is not b.
      const next = await passDeadline(world, c, f.team.id, 25 * 3_600_000);
      expect(next.status).toBe('offering');
      expect(next.pendingOffer).toMatchObject({ kind: 'senior_offer' });
      expect(next.pendingOffer?.userId).not.toBe(b.id);
    });

    it('FR-TEAM-20: the winner who has left can still decline: the vote moves on at once, without the 24 hours', async () => {
      const f = await leaderVote(world, { phase: 'confirming' });
      const [b, c] = [eligibleAt(f, 0), eligibleAt(f, 1)];
      await world.as(b).delete(`/v1/teams/${f.team.id}/members/me`);
      const declined = await world.as(b).post(`${voteBase(f)}/offer-responses`, { accept: false });
      expect(declined.statusCode, declined.body).toBe(200);
      const next = await currentVote(world, c, f.team.id);
      expect(next.status).toBe('offering');
      expect(next.pendingOffer?.userId).not.toBe(b.id);
    });

    it('FR-TEAM-20 (known limitation): the senior member asked to lead leaves: the offer hangs until the deadline, then goes to the next one', async () => {
      const f = await leaderVote(world, { phase: 'offering' });
      const senior = eligibleAt(f, 0);
      const viewer = eligibleAt(f, 1);
      expect(f.vote.pendingOffer).toMatchObject({ userId: senior.id, kind: 'senior_offer' });
      await world.as(senior).delete(`/v1/teams/${f.team.id}/members/me`);
      const waiting = await currentVote(world, viewer, f.team.id);
      expect(waiting.status).toBe('offering');
      expect(waiting.pendingOffer?.userId).toBe(senior.id);
      expectProblem(
        'respondLeaderOffer',
        await world.as(senior).post(`${voteBase(f)}/offer-responses`, { accept: true }),
        403,
        'NOT_ELIGIBLE',
      );
      clock.advance(25 * 3_600_000);
      await world.runMaintenance('vote-deadline-scan');
      const next = await waitFor(async () => {
        const now = await currentVote(world, viewer, f.team.id);
        return now.pendingOffer?.userId !== senior.id ? now : false;
      }, 20_000);
      expect(next.status).toBe('offering');
      expect(next.pendingOffer).toMatchObject({ kind: 'senior_offer' });
    });

    it('FR-TEAM-16: a candidate leaves during the voting: his ballots still count, but a win cannot make him the lead -> offering', async () => {
      const f = await leaderVote(world, { phase: 'voting', members: 5 });
      const [b, c, d, e] = [eligibleAt(f, 0), eligibleAt(f, 1), eligibleAt(f, 2), eligibleAt(f, 3)];
      await world.as(b).delete(`/v1/teams/${f.team.id}/members/me`);
      const url = `${voteBase(f)}/ballots`;
      // eligible = 4: three ballots are a majority (> 2)
      expectOk('castBallot', await world.as(c).post(url, { candidateUserId: b.id }), 201);
      expectOk('castBallot', await world.as(d).post(url, { candidateUserId: b.id }), 201);
      expectOk('castBallot', await world.as(e).post(url, { candidateUserId: b.id }), 201);
      const vote = await currentVote(world, c, f.team.id);
      expect(vote.status).toBe('offering');
      expect(vote.pendingOffer).toMatchObject({ kind: 'senior_offer' });
      expect(vote.pendingOffer?.userId).not.toBe(b.id);
      expect(await teamRow(world, f.team.id)).toMatchObject({
        status: 'voting',
        lead_user_id: null,
      });
    });
  });

  describe('a closed seat (FR-TEAM-12, -29, -30)', () => {
    it('FR-TEAM-29: a join request for a closed seat -> 409 SEAT_NOT_OPEN', async () => {
      const t = await team(world, { openSeats: 2 });
      const seat = t.openSeats[0];
      if (!seat) throw new Error('seat');
      expect((await world.as(t.lead).delete(`/v1/teams/${t.id}/seats/${seat.id}`)).statusCode).toBe(
        204,
      );
      const requester = await githubUser(world, 'closed-requester');
      expectProblem(
        'createJoinRequest',
        await world.as(requester).post(`/v1/teams/${t.id}/join-requests`, { seatId: seat.id }),
        409,
        'SEAT_NOT_OPEN',
      );
    });

    it('FR-TEAM-30: a request made before the seat was closed cannot be accepted by the lead any more -> 409 SEAT_NOT_OPEN, the request is cancelled', async () => {
      const t = await team(world, { openSeats: 2 });
      const seat = t.openSeats[0];
      if (!seat) throw new Error('seat');
      const requester = await githubUser(world, 'closed-request');
      const request = expectOk<OfferDto>(
        'createJoinRequest',
        await world.as(requester).post(`/v1/teams/${t.id}/join-requests`, { seatId: seat.id }),
        201,
      );
      await world.as(t.lead).delete(`/v1/teams/${t.id}/seats/${seat.id}`);
      expectProblem(
        'acceptSeatOffer',
        await world.as(t.lead).post(`/v1/seat-offers/${request.id}/acceptance`),
        409,
        'SEAT_NOT_OPEN',
      );
      const mine = expectOk<{ items: OfferDto[] }>(
        'listMySeatOffers',
        await world.as(requester).get('/v1/me/seat-offers?status=cancelled'),
        200,
      );
      expect(mine.items.map((o) => o.id)).toContain(request.id);
      expect(await activeMemberships(world, t.id)).toBe(1);
    });

    it('FR-TEAM-30: an invitation to a seat that was closed -> 409 SEAT_NOT_OPEN, the invitation is not consumed', async () => {
      const t = await team(world, { openSeats: 2 });
      const seat = t.openSeats[0];
      if (!seat) throw new Error('seat');
      const created = expectOk<{ token: string; invitation: InvitationDto }>(
        'createInvitation',
        await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }),
        201,
      );
      await world.as(t.lead).delete(`/v1/teams/${t.id}/seats/${seat.id}`);
      const invitee = await githubUser(world, 'closed-invitee');
      expectProblem(
        'acceptInvitation',
        await world.as(invitee).post('/v1/invitation-acceptances', { token: created.token }),
        409,
        'SEAT_NOT_OPEN',
      );
      expect(await activeMembershipsOf(world, invitee.id)).toBe(0);
    });
  });
});
