import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import {
  ballot,
  currentVote,
  DAY,
  expectOk,
  githubUser,
  leaderVote,
  passDeadline,
  team,
  type LeaderVoteFixture,
  type VoteDto,
} from '../../../../test/fixtures/teams.js';
import { eventCount, openVotes, teamRow } from '../../../../test/fixtures/teams-db.js';
import { fireTimer } from '../../../../test/fixtures/teams-timers.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

const HOUR = 3_600_000;

describeInfra('S3 teams: the leader vote (FR-TEAM-14..21)', ['db', 'redis'], () => {
  let world: World;
  const clock = new FakeClock(Date.now());

  beforeAll(async () => {
    world = await startWorld({ clock });
  });

  afterAll(async () => {
    if (!world) return;
    await world.close();
  });

  const base = (f: LeaderVoteFixture) => `/v1/teams/${f.team.id}/leader-votes/${f.voteId}`;
  const member = (f: LeaderVoteFixture, i: number) => {
    const m = f.eligible[i];
    if (!m) throw new Error(`no eligible member ${i}`);
    return m;
  };

  describe('listLeaderVotes and the inactivity request counter', () => {
    it('FR-TEAM-21: members read the votes, the open one first; the numbers of votes are hidden while it is open', async () => {
      const f = await leaderVote(world, { phase: 'voting' });
      const page = expectOk<{ items: VoteDto[] }>(
        'listLeaderVotes',
        await world.as(member(f, 1)).get(`/v1/teams/${f.team.id}/leader-votes`),
        200,
      );
      expect(page.items[0]).toMatchObject({
        id: f.voteId,
        status: 'voting',
        round: 1,
        eligibleCount: 3,
        quorum: 2,
        canVote: true,
        myBallotCast: false,
      });
      expect(page.items[0]?.candidates.every((c) => c.votes === null)).toBe(true);
    });

    it('FR-TEAM-21: the former lead and strangers do not see the votes (404)', async () => {
      const f = await leaderVote(world, { phase: 'nominating' });
      expectProblem(
        'listLeaderVotes',
        await world.as(f.formerLead).get(`/v1/teams/${f.team.id}/leader-votes`),
        404,
        'NOT_FOUND',
      );
    });

    it('FR-TEAM-14: the request counter starts at 0 of ceil(N/2)', async () => {
      const t = await team(world, { members: 5, openSeats: 0, status: 'active' });
      const counter = expectOk<{ requests: number; required: number; voteId?: string | null }>(
        'getLeaderVoteRequests',
        await world.as(t.members[0] ?? t.lead).get(`/v1/teams/${t.id}/leader-vote-requests`),
        200,
      );
      expect(counter).toMatchObject({ requests: 0, required: 3 });
    });

    it('FR-TEAM-14: while the lead is active (not 14 days idle) a request -> 409 INVALID_STATE', async () => {
      const t = await team(world, { members: 3, openSeats: 0, status: 'active' });
      const response = await world
        .as(t.members[0] ?? t.lead)
        .post(`/v1/teams/${t.id}/leader-vote-requests`);
      expectProblem('requestLeaderVote', response, 409, 'INVALID_STATE');
      expect(await openVotes(world, t.id)).toBe(0);
    });

    it('FR-TEAM-14 (C-15): after 14 idle days the requests of ceil(N/2) members open a vote; fewer do not', async () => {
      const t = await team(world, { members: 5, openSeats: 0, status: 'active' });
      clock.advance(15 * DAY);
      const [a, b, c] = t.members;
      if (!a || !b || !c) throw new Error('no members');
      const first = expectOk<{ requests: number; required: number; voteId?: string | null }>(
        'requestLeaderVote',
        await world.as(a).post(`/v1/teams/${t.id}/leader-vote-requests`),
        201,
      );
      expect(first).toMatchObject({ requests: 1, required: 3 });
      expect(await openVotes(world, t.id)).toBe(0);
      await world.as(b).post(`/v1/teams/${t.id}/leader-vote-requests`);
      const third = expectOk<{ requests: number; voteId?: string | null }>(
        'requestLeaderVote',
        await world.as(c).post(`/v1/teams/${t.id}/leader-vote-requests`),
        201,
      );
      expect(third.voteId).toBeTruthy();
      expect(await openVotes(world, t.id)).toBe(1);
      expect(await teamRow(world, t.id)).toMatchObject({ status: 'voting' });
      expect((await currentVote(world, a, t.id)).trigger).toBe('lead_inactive');
    });

    it('FR-TEAM-14: the lead returns (opens the votes) before the first ballot: the vote is cancelled, the team is restored', async () => {
      const t = await team(world, { members: 3, openSeats: 0, status: 'active' });
      clock.advance(15 * DAY);
      for (const requester of t.members) {
        await world.as(requester).post(`/v1/teams/${t.id}/leader-vote-requests`);
      }
      expect(await teamRow(world, t.id)).toMatchObject({ status: 'voting' });
      const page = expectOk<{ items: VoteDto[] }>(
        'listLeaderVotes',
        await world.as(t.lead).get(`/v1/teams/${t.id}/leader-votes`),
        200,
      );
      expect(page.items[0]).toMatchObject({
        status: 'cancelled',
        outcome: 'cancelled_lead_returned',
      });
      expect(await teamRow(world, t.id)).toMatchObject({
        status: 'active',
        lead_user_id: t.lead.id,
      });
      expect(await openVotes(world, t.id)).toBe(0);
    });

    it('FR-TEAM-14: a stranger cannot request or read the counter -> 404', async () => {
      const t = await team(world, { members: 3, openSeats: 0 });
      const stranger = await githubUser(world, 'request-stranger');
      expectProblem(
        'requestLeaderVote',
        await world.as(stranger).post(`/v1/teams/${t.id}/leader-vote-requests`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        'getLeaderVoteRequests',
        await world.as(stranger).get(`/v1/teams/${t.id}/leader-vote-requests`),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('nominating (FR-TEAM-15)', () => {
    it('FR-TEAM-15: a member nominates himself; the candidate is on the ballot only after his consent', async () => {
      const f = await leaderVote(world, { phase: 'nominating' });
      const b = member(f, 0);
      const nominated = expectOk<VoteDto>(
        'nominateCandidate',
        await world.as(b).post(`${base(f)}/candidates`, { userId: b.id }),
        201,
      );
      expect(nominated.candidates.find((c) => c.userId === b.id)?.confirmed).toBe(false);
      const consented = expectOk<VoteDto>(
        'consentCandidacy',
        await world.as(b).post(`${base(f)}/candidates/${b.id}/consent`),
        200,
      );
      expect(consented.candidates.find((c) => c.userId === b.id)?.confirmed).toBe(true);
    });

    it('FR-TEAM-15: a member nominates another; only the nominee can consent (others get 404)', async () => {
      const f = await leaderVote(world, { phase: 'nominating' });
      const [b, c, d] = [member(f, 0), member(f, 1), member(f, 2)];
      expectOk(
        'nominateCandidate',
        await world.as(b).post(`${base(f)}/candidates`, { userId: c.id }),
        201,
      );
      expectProblem(
        'consentCandidacy',
        await world.as(d).post(`${base(f)}/candidates/${c.id}/consent`),
        404,
        'NOT_FOUND',
      );
      expectOk(
        'consentCandidacy',
        await world.as(c).post(`${base(f)}/candidates/${c.id}/consent`),
        200,
      );
    });

    it('FR-TEAM-15: the same person nominated twice -> 409 CANDIDATE_EXISTS', async () => {
      const f = await leaderVote(world, { phase: 'nominating' });
      const [b, c] = [member(f, 0), member(f, 1)];
      await world.as(b).post(`${base(f)}/candidates`, { userId: b.id });
      expectProblem(
        'nominateCandidate',
        await world.as(c).post(`${base(f)}/candidates`, { userId: b.id }),
        409,
        'CANDIDATE_EXISTS',
      );
    });

    it('FR-TEAM-15: a nominee who has no right to vote -> 403 NOT_ELIGIBLE', async () => {
      const f = await leaderVote(world, { phase: 'nominating' });
      const outsider = await githubUser(world, 'nominate-outsider');
      // The contract (nominateCandidate) names 403 NOT_ELIGIBLE; the body id check of architecture 13.14 would be 404.
      const response = await world
        .as(member(f, 0))
        .post(`${base(f)}/candidates`, { userId: outsider.id });
      expectProblem('nominateCandidate', response, 403, 'NOT_ELIGIBLE');
    });

    it('FR-TEAM-15: nominating after the nomination period -> 409 VOTE_PHASE', async () => {
      const f = await leaderVote(world, { phase: 'voting' });
      const response = await world
        .as(member(f, 1))
        .post(`${base(f)}/candidates`, { userId: member(f, 1).id });
      expectProblem('nominateCandidate', response, 409, 'VOTE_PHASE');
    });

    it('FR-TEAM-16: a candidate withdraws; a second withdrawal -> 409 INVALID_STATE; a non-candidate -> 404', async () => {
      const f = await leaderVote(world, { phase: 'nominating' });
      const [b, c] = [member(f, 0), member(f, 1)];
      await world.as(b).post(`${base(f)}/candidates`, { userId: b.id });
      await world.as(b).post(`${base(f)}/candidates/${b.id}/consent`);
      const withdrawn = expectOk<VoteDto>(
        'withdrawCandidacy',
        await world.as(b).post(`${base(f)}/candidates/me/withdrawal`),
        200,
      );
      expect(withdrawn.candidates.find((x) => x.userId === b.id)?.withdrawn).toBe(true);
      expectProblem(
        'withdrawCandidacy',
        await world.as(b).post(`${base(f)}/candidates/me/withdrawal`),
        409,
        'INVALID_STATE',
      );
      expectProblem(
        'withdrawCandidacy',
        await world.as(c).post(`${base(f)}/candidates/me/withdrawal`),
        404,
        'NOT_FOUND',
      );
    });

    it('FR-TEAM-20: nobody nominated within 24 hours -> offering, the longest-serving member is asked', async () => {
      const f = await leaderVote(world, { phase: 'offering' });
      expect(f.vote.status).toBe('offering');
      expect(f.vote.pendingOffer).toMatchObject({ userId: member(f, 0).id, kind: 'senior_offer' });
    });
  });

  describe('voting (FR-TEAM-16, -17, -19, -21)', () => {
    it('FR-TEAM-16: a ballot is recorded once; the second one -> 409 ALREADY_VOTED; the count stays hidden', async () => {
      const f = await leaderVote(world, { phase: 'voting' });
      const [b, c] = [member(f, 0), member(f, 1)];
      const voted = await ballot(world, f.team, f.voteId, c, b);
      expect(voted).toMatchObject({ myBallotCast: true, ballotsCast: 1, status: 'voting' });
      expect(voted.candidates.every((x) => x.votes === null)).toBe(true);
      const again = await world.as(c).post(`${base(f)}/ballots`, { candidateUserId: b.id });
      expectProblem('castBallot', again, 409, 'ALREADY_VOTED');
    });

    it('FR-TEAM-16: a ballot for someone who is not a confirmed candidate -> 404; nobody sees who voted for whom', async () => {
      const f = await leaderVote(world, { phase: 'voting' });
      const c = member(f, 1);
      const d = member(f, 2);
      expectProblem(
        'castBallot',
        await world.as(c).post(`${base(f)}/ballots`, { candidateUserId: d.id }),
        404,
        'NOT_FOUND',
      );
      await ballot(world, f.team, f.voteId, c, member(f, 0));
      const view = await world.as(d).get(`/v1/teams/${f.team.id}/leader-votes`);
      for (const word of ['voterUserId', 'voter_user_id', 'ballots'])
        expect(view.body, word).not.toContain(word);
    });

    it('FR-TEAM-16: a ballot during the nomination period -> 409 VOTE_PHASE', async () => {
      const f = await leaderVote(world, { phase: 'nominating' });
      const b = member(f, 0);
      await world.as(b).post(`${base(f)}/candidates`, { userId: b.id });
      await world.as(b).post(`${base(f)}/candidates/${b.id}/consent`);
      expectProblem(
        'castBallot',
        await world.as(member(f, 1)).post(`${base(f)}/ballots`, { candidateUserId: b.id }),
        409,
        'VOTE_PHASE',
      );
    });

    it('FR-TEAM-17: more than N/2 ballots for one candidate close the vote early into confirming', async () => {
      const f = await leaderVote(world, { phase: 'confirming' });
      expect(f.vote).toMatchObject({ status: 'confirming' });
      expect(f.vote.pendingOffer).toMatchObject({
        userId: member(f, 0).id,
        kind: 'winner_confirmation',
      });
    });

    it('FR-TEAM-17: the winner confirms: the vote closes, he is the lead, the team returns to its status', async () => {
      const f = await leaderVote(world, { phase: 'confirming' });
      const winner = member(f, 0);
      const closed = expectOk<VoteDto>(
        'respondLeaderOffer',
        await world.as(winner).post(`${base(f)}/offer-responses`, { accept: true }),
        200,
      );
      expect(closed).toMatchObject({
        status: 'closed',
        outcome: 'elected',
        winnerUserId: winner.id,
      });
      expect(await teamRow(world, f.team.id)).toMatchObject({
        status: 'active',
        lead_user_id: winner.id,
      });
      expect(await eventCount(world, f.team.id, 'lead_changed')).toBe(1);
      expect(closed.candidates.find((c) => c.userId === winner.id)?.votes).toBe(2);
    });

    it('FR-TEAM-17: the winner declines: the next candidate by votes, or offering when none is left', async () => {
      const f = await leaderVote(world, { phase: 'confirming' });
      const winner = member(f, 0);
      const after = expectOk<VoteDto>(
        'respondLeaderOffer',
        await world.as(winner).post(`${base(f)}/offer-responses`, { accept: false }),
        200,
      );
      expect(['confirming', 'offering']).toContain(after.status);
      expect(after.pendingOffer?.userId).not.toBe(winner.id);
    });

    it('FR-TEAM-17: only the addressee of the offer may answer (another member -> 403)', async () => {
      const f = await leaderVote(world, { phase: 'confirming' });
      const response = await world
        .as(member(f, 2))
        .post(`${base(f)}/offer-responses`, { accept: true });
      expect(response.statusCode, response.body).toBe(403);
    });

    it('FR-TEAM-21: after the close the vote counts are visible to the team, the voters are not', async () => {
      const f = await leaderVote(world, { phase: 'confirming' });
      await world.as(member(f, 0)).post(`${base(f)}/offer-responses`, { accept: true });
      const view = await world.as(member(f, 2)).get(`/v1/teams/${f.team.id}/leader-votes`);
      const closed = expectOk<{ items: VoteDto[] }>('listLeaderVotes', view, 200).items[0];
      expect(closed?.candidates.map((c) => c.votes)).toEqual([2]);
      for (const word of ['voterUserId', 'voter_user_id', 'ballots'])
        expect(view.body, word).not.toContain(word);
    });

    it('FR-TEAM-18: no quorum at the deadline: one extension of 48 hours, then offering', async () => {
      const f = await leaderVote(world, { phase: 'voting' });
      const viewer = member(f, 1);
      const extended = await passDeadline(world, viewer, f.team.id, 72 * HOUR);
      expect(extended).toMatchObject({ status: 'voting', extended: true });
      const offering = await passDeadline(world, viewer, f.team.id, 48 * HOUR + 60_000);
      expect(offering.status).toBe('offering');
      expect(offering.pendingOffer?.kind).toBe('senior_offer');
    });

    it('FR-TEAM-19: a tie at the deadline starts a runoff between the tied candidates only (24 hours)', async () => {
      const f = await leaderVote(world, { phase: 'runoff' });
      expect(f.vote).toMatchObject({ status: 'runoff', round: 2 });
      const [b, c, d] = [member(f, 0), member(f, 1), member(f, 2)];
      expectProblem(
        'castBallot',
        await world.as(d).post(`${base(f)}/ballots`, { candidateUserId: d.id }),
        404,
        'NOT_FOUND',
      );
      const voted = await ballot(world, f.team, f.voteId, d, c);
      expect(voted.myBallotCast).toBe(true);
      expect(b.id).not.toBe(c.id);
    });

    it('FR-TEAM-19: a second tie is decided in favour of the member who joined the team first', async () => {
      const f = await leaderVote(world, { phase: 'runoff' });
      const [b, c, d, e] = [member(f, 0), member(f, 1), member(f, 2), member(f, 3)];
      await ballot(world, f.team, f.voteId, b, b);
      await ballot(world, f.team, f.voteId, c, c);
      await ballot(world, f.team, f.voteId, d, b);
      await ballot(world, f.team, f.voteId, e, c);
      const decided = await passDeadline(world, d, f.team.id, 24 * HOUR + 60_000);
      expect(decided.status).toBe('confirming');
      expect(decided.pendingOffer?.userId).toBe(b.id);
    });
  });

  describe('offering and suspension (FR-TEAM-20, C-28)', () => {
    it('FR-TEAM-20: the senior member accepts: the vote closes as appointed_senior and he leads', async () => {
      const f = await leaderVote(world, { phase: 'offering' });
      const senior = member(f, 0);
      const closed = expectOk<VoteDto>(
        'respondLeaderOffer',
        await world.as(senior).post(`${base(f)}/offer-responses`, { accept: true }),
        200,
      );
      expect(closed).toMatchObject({
        status: 'closed',
        outcome: 'appointed_senior',
        winnerUserId: senior.id,
      });
      expect((await teamRow(world, f.team.id)).lead_user_id).toBe(senior.id);
    });

    it('FR-TEAM-20: everybody declines: the team is suspended for 14 days and then archived', async () => {
      const f = await leaderVote(world, { phase: 'offering' });
      for (const m of f.eligible) {
        const response = await world.as(m).post(`${base(f)}/offer-responses`, { accept: false });
        expect(response.statusCode, response.body).toBe(200);
      }
      const last = await currentVote(world, member(f, 0), f.team.id);
      expect(last).toMatchObject({ status: 'closed', outcome: 'suspended' });
      expect((await teamRow(world, f.team.id)).status).toBe('suspended');
      clock.advance(15 * DAY);
      await fireTimer(world, 'suspension-expire', { teamId: f.team.id });
      expect((await teamRow(world, f.team.id)).status).toBe('archived');
    });
  });

  it('FR-WORK-08: a ballot repeated with its key replays the stored 201 and counts once', async () => {
    const f = await leaderVote(world, { phase: 'voting' });
    const [b, c] = [member(f, 0), member(f, 1)];
    const key = randomUUID();
    const first = await world
      .as(c)
      .post(`${base(f)}/ballots`, { candidateUserId: b.id }, { idempotencyKey: key });
    expect(first.statusCode).toBe(201);
    const replay = await world
      .as(c)
      .post(`${base(f)}/ballots`, { candidateUserId: b.id }, { idempotencyKey: key });
    expect(replay.statusCode).toBe(201);
    expectReplayed(replay);
    expect((await currentVote(world, c, f.team.id)).ballotsCast).toBe(1);
  });
});
