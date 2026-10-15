import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countOf, expectProblem } from '../../../../test/fixtures/assertions.js';
import { send } from '../../../../test/fixtures/operations.js';
import {
  requestForTeams,
  SLICE3_OPERATIONS,
  type Slice3Operation,
  type TeamsContext,
} from '../../../../test/fixtures/operations-teams.js';
import {
  expectOk,
  githubUser,
  leaderVote,
  teamWithOpenSeat,
  type DepartureDto,
  type InvitationDto,
  type LeaderVoteFixture,
  type OfferDto,
  type TeamWithOpenSeat,
} from '../../../../test/fixtures/teams.js';
import { seatStatus } from '../../../../test/fixtures/teams-db.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import type { World } from '../../../../test/fixtures/world.js';
import { expectIdorResult, idorMatrix } from '../../../../test/helpers/authz.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

const VOTE_OPS = new Set<Slice3Operation>([
  'nominateCandidate',
  'consentCandidacy',
  'withdrawCandidacy',
  'castBallot',
  'returnAsLead',
  'respondLeaderOffer',
]);

describeInfra('S3 teams: authorization matrix from x-authz (IDOR, SEC-03)', ['db', 'redis'], () => {
  let world: World;
  const clock = new FakeClock(Date.now());
  let a: TeamWithOpenSeat;
  let b: TeamWithOpenSeat;
  let vote: LeaderVoteFixture;
  let stranger: UserFixture;
  let offer: OfferDto;
  let invitation: InvitationDto;
  let departure: DepartureDto;
  let voteCaller: UserFixture;

  beforeAll(async () => {
    world = await startWorld({ clock });
    stranger = await githubUser(world, 'idor-stranger');
    a = await teamWithOpenSeat(world, {
      members: 3,
      openSeats: 2,
      candidates: 1,
      status: 'active',
    });
    b = await teamWithOpenSeat(world, {
      members: 2,
      openSeats: 2,
      candidates: 1,
      status: 'active',
    });
    offer = a.offers[0] as OfferDto;
    const seat = a.openSeats[1];
    if (!seat) throw new Error('no seat');
    const created = await world
      .as(a.lead)
      .post(`/v1/teams/${a.id}/invitations`, { seatId: seat.id });
    invitation = expectOk<{ invitation: InvitationDto }>(
      'createInvitation',
      created,
      201,
    ).invitation;
    const leaver = a.members[1];
    if (!leaver) throw new Error('no member');
    await world.as(leaver).delete(`/v1/teams/${a.id}/members/me`);
    const list = expectOk<{ items: DepartureDto[] }>(
      'listDepartures',
      await world.as(a.lead).get(`/v1/teams/${a.id}/departures`),
      200,
    );
    departure = list.items[0] as DepartureDto;
    vote = await leaderVote(world, { phase: 'nominating' });
    voteCaller = vote.eligible[0] as UserFixture;
  });

  afterAll(async () => {
    if (!world) return;
    await world.close();
  });

  const contextOf = (operationId: Slice3Operation): TeamsContext => {
    if (VOTE_OPS.has(operationId)) {
      return { teamId: vote.team.id, voteId: vote.voteId, userId: voteCaller.id };
    }
    return {
      teamId: a.id,
      seatId: a.openSeats[0]?.id ?? '',
      offerId: offer.id,
      invitationId: invitation.id,
      departureId: departure.id,
      userId: a.candidates[0]?.id ?? '',
    };
  };

  const OPERATIONS = SLICE3_OPERATIONS.filter((id) => id !== 'listProductTypes');

  describe('(а) without a session -> 401 for every non-public operation', () => {
    it.each(OPERATIONS)('FR-AUTH-03: %s', async (operationId) => {
      const anonymous = idorMatrix(operationId).cases.find((c) => c.kind === 'anonymous');
      expect(anonymous, `${operationId} is public in the contract`).toBeDefined();
      const response = await send(
        world.anonymous(),
        requestForTeams(operationId, contextOf(operationId)),
      );
      if (anonymous) expectIdorResult(anonymous, response);
      expectProblem(operationId, response, 401, 'UNAUTHENTICATED');
    });
  });

  describe('(а) a user outside the team gets 404, never 403', () => {
    const SCOPED = OPERATIONS.filter((id) =>
      idorMatrix(id).cases.some((c) => c.kind === 'outsider'),
    );

    it('FR-TEAM-02: the matrix covers the team-scoped operations of the contract', () => {
      expect(SCOPED.length).toBeGreaterThanOrEqual(20);
      expect(SCOPED).toEqual(
        expect.arrayContaining([
          'getLeaderVoteRequests',
          'listTeamEvents',
          'acceptSeatOffer',
          'rejectSeatOffer',
        ]),
      );
    });

    it.each(SCOPED)('FR-TEAM-02: %s', async (operationId) => {
      const outsider = idorMatrix(operationId).cases.find((c) => c.kind === 'outsider');
      const response = await send(
        world.as(stranger),
        requestForTeams(operationId, contextOf(operationId)),
      );
      if (outsider) expectIdorResult(outsider, response);
      expectProblem(operationId, response, 404, 'NOT_FOUND');
    });

    it('FR-TEAM-02: a foreign team and an unknown team look the same (no existence oracle)', async () => {
      const foreign = await world.as(stranger).get(`/v1/teams/${a.id}/events`);
      const unknown = await world
        .as(stranger)
        .get('/v1/teams/00000000-0000-4000-8000-000000000999/events');
      expect(foreign.statusCode).toBe(unknown.statusCode);
      const strip = (r: typeof foreign) => {
        const body = r.json<Record<string, unknown>>();
        delete body.requestId;
        delete body.instance;
        return body;
      };
      expect(strip(foreign)).toEqual(strip(unknown));
    });
  });

  describe('(б) a nested id taken from another team gives 404 and changes nothing', () => {
    const NESTED: [
      Slice3Operation,
      (own: TeamWithOpenSeat, foreign: TeamWithOpenSeat) => TeamsContext,
    ][] = [
      [
        'updateSeat',
        (own, foreign) => ({ teamId: own.id, seatId: foreign.openSeats[0]?.id ?? '' }),
      ],
      ['closeSeat', (own, foreign) => ({ teamId: own.id, seatId: foreign.openSeats[0]?.id ?? '' })],
      ['revokeInvitation', (own) => ({ teamId: own.id, invitationId: invitation.id })],
      ['decideDeparture', (own) => ({ teamId: own.id, departureId: departure.id })],
    ];

    it.each(NESTED)('FR-TEAM-02: %s with an id of the other team', async (operationId, build) => {
      const swapped = idorMatrix(operationId).cases.filter((c) => c.kind === 'swapped-id');
      expect(swapped.length).toBeGreaterThan(0);
      const request = requestForTeams(operationId, build(b, a));
      const response = await send(world.as(b.lead), request);
      for (const c of swapped) expectIdorResult(c, response);
      expectProblem(operationId, response, 404, 'NOT_FOUND');
      expect(await seatStatus(world, a.openSeats[0]?.id ?? '')).toBe('open');
    });

    it('FR-TEAM-02: the reverse direction: teamId of A with a seat of B -> 404', async () => {
      const seatB = b.openSeats[0];
      if (!seatB) throw new Error('no seat');
      for (const operationId of ['updateSeat', 'closeSeat'] as const) {
        const response = await send(
          world.as(a.lead),
          requestForTeams(operationId, { teamId: a.id, seatId: seatB.id }),
        );
        expectProblem(operationId, response, 404, 'NOT_FOUND');
      }
      expect(await seatStatus(world, seatB.id)).toBe('open');
    });

    it.each([...VOTE_OPS])('FR-TEAM-15: %s with a voteId of another team', async (operationId) => {
      const swapped = idorMatrix(operationId).cases.filter((c) => c.kind === 'swapped-id');
      expect(swapped.length).toBeGreaterThan(0);
      const request = requestForTeams(operationId, {
        teamId: b.id,
        voteId: vote.voteId,
        userId: b.members[0]?.id ?? '',
      });
      // a lead operation is reached by the lead of team `b` only; a member would stop at 403
      const caller = operationId === 'returnAsLead' ? b.lead : (b.members[0] ?? b.lead);
      const response = await send(world.as(caller), request);
      expectProblem(operationId, response, 404, 'NOT_FOUND');
      const open = await countOf(world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM teams.vote_ballot WHERE vote_id = ${vote.voteId}`);
      expect(open).toBe(0);
    });

    it('FR-TEAM-08: a body seatId of another team in createInvitation, createSeatOffer and createJoinRequest -> 404', async () => {
      const foreignSeat = b.openSeats[0]?.id ?? '';
      const candidate = a.candidates[0]?.id ?? '';
      expectProblem(
        'createInvitation',
        await send(
          world.as(a.lead),
          requestForTeams('createInvitation', { teamId: a.id, seatId: foreignSeat }),
        ),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        'createSeatOffer',
        await send(
          world.as(a.lead),
          requestForTeams('createSeatOffer', {
            teamId: a.id,
            seatId: foreignSeat,
            userId: candidate,
          }),
        ),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        'createJoinRequest',
        await send(
          world.as(stranger),
          requestForTeams('createJoinRequest', { teamId: a.id, seatId: foreignSeat }),
        ),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('(в) a role below the required one gets 403 with a code', () => {
    // the vote operations run on the vote team, whose roster is not the one of team `a`
    const LEAD_OPS = OPERATIONS.filter(
      (id) => !VOTE_OPS.has(id) && idorMatrix(id).cases.some((c) => c.kind === 'low-role'),
    );

    it.each(LEAD_OPS)(
      'FR-TEAM-02: %s by a member who is not the lead -> 403 NOT_TEAM_LEAD',
      async (operationId) => {
        const lowRole = idorMatrix(operationId).cases.find((c) => c.kind === 'low-role');
        const member = a.members[0];
        if (!member) throw new Error('no member');
        const response = await send(
          world.as(member),
          requestForTeams(operationId, contextOf(operationId)),
        );
        if (lowRole) expectIdorResult(lowRole, response);
        expectProblem(operationId, response, 403, 'NOT_TEAM_LEAD');
      },
    );
  });

  describe('(в) returnAsLead: a member of the vote team who is not its lead', () => {
    it('FR-TEAM-14: -> 403 NOT_TEAM_LEAD', async () => {
      const lowRole = idorMatrix('returnAsLead').cases.find((c) => c.kind === 'low-role');
      expect(lowRole, 'returnAsLead is a team-lead operation').toBeDefined();
      const response = await send(
        world.as(voteCaller),
        requestForTeams('returnAsLead', contextOf('returnAsLead')),
      );
      if (lowRole) expectIdorResult(lowRole, response);
      expectProblem('returnAsLead', response, 403, 'NOT_TEAM_LEAD');
    });
  });

  describe('named cases of the plan', () => {
    it('FR-TEAM-30: acceptSeatOffer by a stranger -> 404 for an offer and for a request', async () => {
      const seat = b.openSeats[1];
      if (!seat) throw new Error('no seat');
      const request = expectOk<OfferDto>(
        'createJoinRequest',
        await world.as(stranger).post(`/v1/teams/${b.id}/join-requests`, { seatId: seat.id }),
        201,
      );
      const intruder = await githubUser(world, 'idor-intruder');
      expectProblem(
        'acceptSeatOffer',
        await world.as(intruder).post(`/v1/seat-offers/${offer.id}/acceptance`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        'acceptSeatOffer',
        await world.as(intruder).post(`/v1/seat-offers/${request.id}/acceptance`),
        404,
        'NOT_FOUND',
      );
      expect(await seatStatus(world, seat.id)).toBe('open');
    });

    it("FR-TEAM-30: the offer addressee withdrawing someone else's request -> 404", async () => {
      const candidate = b.candidates[0];
      const seat = b.openSeats[1];
      if (!candidate || !seat) throw new Error('no fixture');
      const other = await githubUser(world, 'idor-request-owner');
      const request = expectOk<OfferDto>(
        'createJoinRequest',
        await world.as(other).post(`/v1/teams/${b.id}/join-requests`, { seatId: seat.id }),
        201,
      );
      expectProblem(
        'rejectSeatOffer',
        await world.as(candidate).post(`/v1/seat-offers/${request.id}/rejection`),
        404,
        'NOT_FOUND',
      );
    });

    it('FR-TEAM-15: castBallot by a user who is not a participant of the vote -> 404 (outsider of the team)', async () => {
      const candidate = voteCaller.id;
      const response = await world
        .as(stranger)
        .post(`/v1/teams/${vote.team.id}/leader-votes/${vote.voteId}/ballots`, {
          candidateUserId: candidate,
        });
      expectProblem('castBallot', response, 404, 'NOT_FOUND');
    });

    it('FR-TEAM-21: the former lead, who left, no longer sees the votes of the team', async () => {
      expectProblem(
        'listLeaderVotes',
        await world.as(vote.formerLead).get(`/v1/teams/${vote.team.id}/leader-votes`),
        404,
        'NOT_FOUND',
      );
    });

    it('FR-TEAM-21: a team member sees the journal of his own team only', async () => {
      const member = b.members[0];
      if (!member) throw new Error('no member');
      expectOk('listTeamEvents', await world.as(member).get(`/v1/teams/${b.id}/events`), 200);
      expectProblem(
        'listTeamEvents',
        await world.as(member).get(`/v1/teams/${a.id}/events`),
        404,
        'NOT_FOUND',
      );
    });

    it('FR-TEAM-02: getTeam stays readable by any signed-in user, listTeams too (public card)', async () => {
      expectOk('getTeam', await world.as(stranger).get(`/v1/teams/${a.id}`), 200);
      expectOk('listTeams', await world.as(stranger).get('/v1/teams'), 200);
    });
  });
});
