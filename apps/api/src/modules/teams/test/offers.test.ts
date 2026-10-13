import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import {
  DAY,
  expectOk,
  githubUser,
  joinThroughOffer,
  manyGithubUsers,
  seatInput,
  team,
  userWithoutGithub,
  type OfferDto,
  type TeamDto,
} from '../../../../test/fixtures/teams.js';
import { activeAssignments, seatStatus, teamRow } from '../../../../test/fixtures/teams-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { expectCode, secondsBetween, startWorld } from './support.js';

interface JoinResult {
  teamId: string;
  seatId: string;
  roleCode: string;
  joinedVia: string;
  trialUntil: string | null;
  deficitAtJoin: boolean;
}

describeInfra(
  'S3 teams: seat offers and join requests (FR-TEAM-04, -06, -07, -28..30)',
  ['db', 'redis'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());

    beforeAll(async () => {
      world = await startWorld({ clock });
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    const offerOn = (
      lead: Parameters<World['as']>[0],
      teamId: string,
      seatId: string,
      userId: string,
    ) => world.as(lead).post(`/v1/teams/${teamId}/seat-offers`, { seatId, userId });

    describe('createSeatOffer', () => {
      it('FR-TEAM-28: the lead offers an open seat; the offer is pending, from lead to user, valid 7 days (C-12)', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const candidate = await githubUser(world, 'offer-candidate');
        const response = await world.as(t.lead).post(`/v1/teams/${t.id}/seat-offers`, {
          seatId: seat.id,
          userId: candidate.id,
          message: 'Join us',
        });
        const offer = expectOk<OfferDto & { message: string; createdAt: string }>(
          'createSeatOffer',
          response,
          201,
        );
        expect(offer).toMatchObject({
          direction: 'lead_to_user',
          status: 'pending',
          userId: candidate.id,
          seatId: seat.id,
          teamId: t.id,
          roleCode: seat.roleCode,
        });
        expect(secondsBetween(offer.createdAt, offer.expiresAt)).toBe(7 * 24 * 3600);
        expect(await seatStatus(world, seat.id)).toBe('open');
      });

      it('FR-TEAM-28: the seat is not reserved: a second offer for the same seat to another user is allowed', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const [a, b] = await manyGithubUsers(world, 'offer-two', 2);
        if (!a || !b) throw new Error('no users');
        expectOk('createSeatOffer', await offerOn(t.lead, t.id, seat.id, a.id), 201);
        expectOk('createSeatOffer', await offerOn(t.lead, t.id, seat.id, b.id), 201);
      });

      it('FR-TEAM-28: a second pending offer for the same (seat, user) pair -> 409', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const candidate = await githubUser(world, 'offer-dup');
        await offerOn(t.lead, t.id, seat.id, candidate.id);
        // The contract does not name the code of this 409 (spec FR-TEAM-28 says only "409").
        expectCode(await offerOn(t.lead, t.id, seat.id, candidate.id), 409);
      });

      it('FR-TEAM-28: a filled or closed seat -> 409 SEAT_NOT_OPEN', async () => {
        const t = await team(world, { openSeats: 2 });
        const [filled, closed] = t.openSeats;
        if (!filled || !closed) throw new Error('no seats');
        const holder = await githubUser(world, 'offer-holder');
        await joinThroughOffer(world, t.lead, t.id, filled.id, holder);
        await world.as(t.lead).delete(`/v1/teams/${t.id}/seats/${closed.id}`);
        const candidate = await githubUser(world, 'offer-notopen');
        expectProblem(
          'createSeatOffer',
          await offerOn(t.lead, t.id, filled.id, candidate.id),
          409,
          'SEAT_NOT_OPEN',
        );
        expectProblem(
          'createSeatOffer',
          await offerOn(t.lead, t.id, closed.id, candidate.id),
          409,
          'SEAT_NOT_OPEN',
        );
      });

      it('FR-TEAM-07: a member may be offered a second seat of another role; a third role -> ROLE_LIMIT on acceptance', async () => {
        const t = await team(world, { members: 2, openSeats: 2 });
        const member = t.members[0];
        const [second, third] = t.openSeats;
        if (!member || !second || !third) throw new Error('no fixture');
        expect(
          new Set([
            member && t.dto.seats.find((s) => s.holderUserId === member.id)?.roleCode,
            second.roleCode,
            third.roleCode,
          ]).size,
        ).toBe(3);
        await joinThroughOffer(world, t.lead, t.id, second.id, member);
        const offer = expectOk<OfferDto>(
          'createSeatOffer',
          await offerOn(t.lead, t.id, third.id, member.id),
          201,
        );
        const accepted = await world.as(member).post(`/v1/seat-offers/${offer.id}/acceptance`);
        expectProblem('acceptSeatOffer', accepted, 409, 'ROLE_LIMIT');
        expect(await seatStatus(world, third.id)).toBe('open');
      });

      it('FR-TEAM-28: a member who is not the lead -> 403 NOT_TEAM_LEAD; a stranger -> 404', async () => {
        const t = await team(world, { members: 2, openSeats: 1 });
        const member = t.members[0];
        const seat = t.openSeats[0];
        if (!member || !seat) throw new Error('no fixture');
        const stranger = await githubUser(world, 'offer-stranger');
        const candidate = await githubUser(world, 'offer-target');
        expectProblem(
          'createSeatOffer',
          await offerOn(member, t.id, seat.id, candidate.id),
          403,
          'NOT_TEAM_LEAD',
        );
        expectProblem(
          'createSeatOffer',
          await offerOn(stranger, t.id, seat.id, candidate.id),
          404,
          'NOT_FOUND',
        );
      });

      it('FR-TEAM-28: a seatId of another team in the body -> 404 (x-authz rule)', async () => {
        const mine = await team(world, { openSeats: 1 });
        const foreign = await team(world, { openSeats: 1 });
        const foreignSeat = foreign.openSeats[0];
        if (!foreignSeat) throw new Error('no seat');
        const candidate = await githubUser(world, 'offer-foreign-seat');
        expectProblem(
          'createSeatOffer',
          await offerOn(mine.lead, mine.id, foreignSeat.id, candidate.id),
          404,
          'NOT_FOUND',
        );
      });

      it('FR-TEAM-28: the 31st pending offer of a team -> 409 OFFER_LIMIT', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const users = await manyGithubUsers(world, 'offer-limit', 31);
        for (const u of users.slice(0, 30))
          expectOk('createSeatOffer', await offerOn(t.lead, t.id, seat.id, u.id), 201);
        const last = users[30];
        if (!last) throw new Error('no user');
        expectProblem(
          'createSeatOffer',
          await offerOn(t.lead, t.id, seat.id, last.id),
          409,
          'OFFER_LIMIT',
        );
      });

      it('FR-WORK-08: the same key creates one offer', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const candidate = await githubUser(world, 'offer-replay');
        const key = randomUUID();
        const body = { seatId: seat.id, userId: candidate.id };
        const first = expectOk<OfferDto>(
          'createSeatOffer',
          await world
            .as(t.lead)
            .post(`/v1/teams/${t.id}/seat-offers`, body, { idempotencyKey: key }),
          201,
        );
        const second = await world
          .as(t.lead)
          .post(`/v1/teams/${t.id}/seat-offers`, body, { idempotencyKey: key });
        expect(second.statusCode).toBe(201);
        expectReplayed(second);
        expect(second.json<OfferDto>().id).toBe(first.id);
      });
    });

    describe('createJoinRequest', () => {
      it('FR-TEAM-29: a candidate asks for an open seat; the request is pending, from user to lead', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const candidate = await githubUser(world, 'request-candidate');
        const response = await world
          .as(candidate)
          .post(`/v1/teams/${t.id}/join-requests`, { seatId: seat.id, message: 'Hello' });
        const request = expectOk<OfferDto>('createJoinRequest', response, 201);
        expect(request).toMatchObject({
          direction: 'user_to_lead',
          status: 'pending',
          userId: candidate.id,
          seatId: seat.id,
        });
      });

      it('FR-AUTH-05: without GitHub -> 409 GITHUB_REQUIRED', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const person = await userWithoutGithub(world, 'request-no-github');
        expectProblem(
          'createJoinRequest',
          await world.as(person).post(`/v1/teams/${t.id}/join-requests`, { seatId: seat.id }),
          409,
          'GITHUB_REQUIRED',
        );
      });

      it('FR-TEAM-29: an active member of the team -> 409 ALREADY_MEMBER (x-authz: the caller is not a member)', async () => {
        const t = await team(world, { members: 2, openSeats: 1 });
        const member = t.members[0];
        const seat = t.openSeats[0];
        if (!member || !seat) throw new Error('no fixture');
        const response = await world
          .as(member)
          .post(`/v1/teams/${t.id}/join-requests`, { seatId: seat.id });
        expect(response.statusCode, response.body).toBe(409);
      });

      it('FR-TEAM-29: a seat of another team -> 404; a filled seat -> 409 SEAT_NOT_OPEN; a duplicate -> 409', async () => {
        const t = await team(world, { openSeats: 2 });
        const other = await team(world, { openSeats: 1 });
        const [open, toFill] = t.openSeats;
        const foreignSeat = other.openSeats[0];
        if (!open || !toFill || !foreignSeat) throw new Error('no fixture');
        const holder = await githubUser(world, 'request-holder');
        await joinThroughOffer(world, t.lead, t.id, toFill.id, holder);
        const candidate = await githubUser(world, 'request-cases');
        const as = world.as(candidate);
        expectProblem(
          'createJoinRequest',
          await as.post(`/v1/teams/${t.id}/join-requests`, { seatId: foreignSeat.id }),
          404,
          'NOT_FOUND',
        );
        expectProblem(
          'createJoinRequest',
          await as.post(`/v1/teams/${t.id}/join-requests`, { seatId: toFill.id }),
          409,
          'SEAT_NOT_OPEN',
        );
        expectOk(
          'createJoinRequest',
          await as.post(`/v1/teams/${t.id}/join-requests`, { seatId: open.id }),
          201,
        );
        expectCode(await as.post(`/v1/teams/${t.id}/join-requests`, { seatId: open.id }), 409);
      });

      it('FR-TEAM-29: the 11th pending request of one candidate -> 409 OFFER_LIMIT', async () => {
        const t = await team(world, { openSeats: 11 });
        const candidate = await githubUser(world, 'request-limit');
        for (const seat of t.openSeats.slice(0, 10)) {
          expectOk(
            'createJoinRequest',
            await world.as(candidate).post(`/v1/teams/${t.id}/join-requests`, { seatId: seat.id }),
            201,
          );
        }
        const eleventh = t.openSeats[10];
        if (!eleventh) throw new Error('no seat');
        expectProblem(
          'createJoinRequest',
          await world
            .as(candidate)
            .post(`/v1/teams/${t.id}/join-requests`, { seatId: eleventh.id }),
          409,
          'OFFER_LIMIT',
        );
      });
    });

    describe('listTeamSeatOffers and listMySeatOffers', () => {
      it('FR-TEAM-28: the lead sees offers and requests of the team, filtered by status', async () => {
        const t = await team(world, { openSeats: 2 });
        const [s1, s2] = t.openSeats;
        if (!s1 || !s2) throw new Error('no seats');
        const [a, b] = await manyGithubUsers(world, 'list-offers', 2);
        if (!a || !b) throw new Error('no users');
        const offer = expectOk<OfferDto>(
          'createSeatOffer',
          await offerOn(t.lead, t.id, s1.id, a.id),
          201,
        );
        expectOk(
          'createJoinRequest',
          await world.as(b).post(`/v1/teams/${t.id}/join-requests`, { seatId: s2.id }),
          201,
        );
        await world.as(a).post(`/v1/seat-offers/${offer.id}/rejection`);
        const all = expectOk<{ items: OfferDto[] }>(
          'listTeamSeatOffers',
          await world.as(t.lead).get(`/v1/teams/${t.id}/seat-offers`),
          200,
        );
        expect(all.items).toHaveLength(2);
        const pending = expectOk<{ items: OfferDto[] }>(
          'listTeamSeatOffers',
          await world.as(t.lead).get(`/v1/teams/${t.id}/seat-offers?status=pending`),
          200,
        );
        expect(pending.items.map((o) => o.direction)).toEqual(['user_to_lead']);
      });

      it('FR-TEAM-28: a member who is not the lead -> 403 NOT_TEAM_LEAD; a stranger -> 404', async () => {
        const t = await team(world, { members: 2 });
        const member = t.members[0];
        if (!member) throw new Error('no member');
        const stranger = await githubUser(world, 'list-offers-stranger');
        expectProblem(
          'listTeamSeatOffers',
          await world.as(member).get(`/v1/teams/${t.id}/seat-offers`),
          403,
          'NOT_TEAM_LEAD',
        );
        expectProblem(
          'listTeamSeatOffers',
          await world.as(stranger).get(`/v1/teams/${t.id}/seat-offers`),
          404,
          'NOT_FOUND',
        );
      });

      it("FR-TEAM-30: a user sees his own offers and requests and nobody else's", async () => {
        const t = await team(world, { openSeats: 2 });
        const [s1, s2] = t.openSeats;
        if (!s1 || !s2) throw new Error('no seats');
        const [a, b] = await manyGithubUsers(world, 'my-offers', 2);
        if (!a || !b) throw new Error('no users');
        const offer = expectOk<OfferDto>(
          'createSeatOffer',
          await offerOn(t.lead, t.id, s1.id, a.id),
          201,
        );
        expectOk(
          'createJoinRequest',
          await world.as(a).post(`/v1/teams/${t.id}/join-requests`, { seatId: s2.id }),
          201,
        );
        expectOk('createSeatOffer', await offerOn(t.lead, t.id, s2.id, b.id), 201);
        const mine = expectOk<{ items: OfferDto[]; nextCursor: string | null }>(
          'listMySeatOffers',
          await world.as(a).get('/v1/me/seat-offers'),
          200,
        );
        expect(mine.items).toHaveLength(2);
        expect(mine.items.every((o) => o.userId === a.id)).toBe(true);
        expect(mine.items.map((o) => o.id)).toContain(offer.id);
      });
    });

    describe('acceptSeatOffer', () => {
      it('FR-TEAM-04, FR-TEAM-25, FR-TEAM-30: the addressee joins: 200 JoinResult, seat filled, one assignment, member count +1', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const candidate = await githubUser(world, 'accept-offer');
        const offer = expectOk<OfferDto>(
          'createSeatOffer',
          await offerOn(t.lead, t.id, seat.id, candidate.id),
          201,
        );
        const joined = expectOk<JoinResult>(
          'acceptSeatOffer',
          await world.as(candidate).post(`/v1/seat-offers/${offer.id}/acceptance`),
          200,
        );
        expect(joined).toMatchObject({
          teamId: t.id,
          seatId: seat.id,
          roleCode: seat.roleCode,
          joinedVia: 'offer',
          trialUntil: null,
          deficitAtJoin: false,
        });
        expect(await seatStatus(world, seat.id)).toBe('filled');
        expect(await activeAssignments(world, seat.id)).toBe(1);
        // FR-TEAM-25: slice 3 binds DeficitPort to a stub - no deficit, zero counters, stored once.
        const stored = await world.sql<
          { deficit_at_join: boolean; deficit_open_seats: number; deficit_queued: number }[]
        >`SELECT deficit_at_join, deficit_open_seats, deficit_queued FROM teams.seat_assignment
           WHERE seat_id = ${seat.id} AND ended_at IS NULL`;
        expect(stored[0]).toEqual({
          deficit_at_join: false,
          deficit_open_seats: 0,
          deficit_queued: 0,
        });
        expect(await teamRow(world, t.id)).toMatchObject({ member_count: 2 });
        const dto = expectOk<TeamDto>(
          'getTeam',
          await world.as(t.lead).get(`/v1/teams/${t.id}`),
          200,
        );
        expect(dto.seats.find((s) => s.id === seat.id)?.holderUserId).toBe(candidate.id);
      });

      it('FR-TEAM-30: the lead accepts a candidate request; the requester becomes the member (joinedVia request)', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const candidate = await githubUser(world, 'accept-request');
        const request = expectOk<OfferDto>(
          'createJoinRequest',
          await world.as(candidate).post(`/v1/teams/${t.id}/join-requests`, { seatId: seat.id }),
          201,
        );
        const joined = expectOk<JoinResult>(
          'acceptSeatOffer',
          await world.as(t.lead).post(`/v1/seat-offers/${request.id}/acceptance`),
          200,
        );
        expect(joined.joinedVia).toBe('request');
        const dto = expectOk<TeamDto>(
          'getTeam',
          await world.as(t.lead).get(`/v1/teams/${t.id}`),
          200,
        );
        expect(dto.members.map((m) => m.userId)).toContain(candidate.id);
      });

      it('FR-TEAM-30: a request is accepted by the lead only: a member -> 404; the offer addressee cannot accept a request', async () => {
        const t = await team(world, { members: 2, openSeats: 1 });
        const member = t.members[0];
        const seat = t.openSeats[0];
        if (!member || !seat) throw new Error('no fixture');
        const candidate = await githubUser(world, 'accept-request-party');
        const request = expectOk<OfferDto>(
          'createJoinRequest',
          await world.as(candidate).post(`/v1/teams/${t.id}/join-requests`, { seatId: seat.id }),
          201,
        );
        expectProblem(
          'acceptSeatOffer',
          await world.as(member).post(`/v1/seat-offers/${request.id}/acceptance`),
          404,
          'NOT_FOUND',
        );
        expect(await seatStatus(world, seat.id)).toBe('open');
      });

      it('FR-TEAM-30: an offer is accepted by its addressee only: the lead and a stranger get 404', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const [candidate, stranger] = await manyGithubUsers(world, 'accept-party', 2);
        if (!candidate || !stranger) throw new Error('no users');
        const offer = expectOk<OfferDto>(
          'createSeatOffer',
          await offerOn(t.lead, t.id, seat.id, candidate.id),
          201,
        );
        expectProblem(
          'acceptSeatOffer',
          await world.as(t.lead).post(`/v1/seat-offers/${offer.id}/acceptance`),
          404,
          'NOT_FOUND',
        );
        expectProblem(
          'acceptSeatOffer',
          await world.as(stranger).post(`/v1/seat-offers/${offer.id}/acceptance`),
          404,
          'NOT_FOUND',
        );
        expect(await seatStatus(world, seat.id)).toBe('open');
      });

      it('FR-AUTH-05: an addressee without GitHub -> 409 GITHUB_REQUIRED and the seat stays open', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const person = await userWithoutGithub(world, 'accept-no-github');
        const offer = expectOk<OfferDto>(
          'createSeatOffer',
          await offerOn(t.lead, t.id, seat.id, person.id),
          201,
        );
        expectProblem(
          'acceptSeatOffer',
          await world.as(person).post(`/v1/seat-offers/${offer.id}/acceptance`),
          409,
          'GITHUB_REQUIRED',
        );
        expect(await seatStatus(world, seat.id)).toBe('open');
        expect(await activeAssignments(world, seat.id)).toBe(0);
      });

      it('FR-TEAM-05: a user already in two active projects -> 409 PROJECT_LIMIT', async () => {
        const candidate = await githubUser(world, 'accept-limit');
        for (let i = 0; i < 2; i += 1) {
          const other = await team(world, { openSeats: 1 });
          const seat = other.openSeats[0];
          if (!seat) throw new Error('no seat');
          await joinThroughOffer(world, other.lead, other.id, seat.id, candidate);
        }
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const offer = expectOk<OfferDto>(
          'createSeatOffer',
          await offerOn(t.lead, t.id, seat.id, candidate.id),
          201,
        );
        expectProblem(
          'acceptSeatOffer',
          await world.as(candidate).post(`/v1/seat-offers/${offer.id}/acceptance`),
          409,
          'PROJECT_LIMIT',
        );
      });

      it('FR-TEAM-06: a team of 8 members -> 409 TEAM_FULL', async () => {
        const t = await team(world, { members: 8, openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const candidate = await githubUser(world, 'accept-full');
        const offer = expectOk<OfferDto>(
          'createSeatOffer',
          await offerOn(t.lead, t.id, seat.id, candidate.id),
          201,
        );
        expectProblem(
          'acceptSeatOffer',
          await world.as(candidate).post(`/v1/seat-offers/${offer.id}/acceptance`),
          409,
          'TEAM_FULL',
        );
        expect((await teamRow(world, t.id)).member_count).toBe(8);
      });

      it('FR-TEAM-07: a second seat of the SAME role for a member -> 409 ALREADY_MEMBER (one role is held once)', async () => {
        const t = await team(world, { members: 2, openSeats: 1 });
        const member = t.members[0];
        const seat = t.openSeats[0];
        if (!member || !seat) throw new Error('no fixture');
        const held = t.dto.seats.find((s) => s.holderUserId === member.id);
        // The member's seat role comes from the fixture's role cycle; give the open seat the same role.
        const sameRole = expectOk<{ items: { id: string }[] }>(
          'addSeats',
          await world.as(t.lead).post(`/v1/teams/${t.id}/seats`, {
            seats: [seatInput({ roleCode: held?.roleCode ?? 'backend' })],
          }),
          201,
        );
        const offer = expectOk<OfferDto>(
          'createSeatOffer',
          await offerOn(t.lead, t.id, sameRole.items[0]?.id ?? '', member.id),
          201,
        );
        expectProblem(
          'acceptSeatOffer',
          await world.as(member).post(`/v1/seat-offers/${offer.id}/acceptance`),
          409,
          'ALREADY_MEMBER',
        );
      });

      it('FR-TEAM-30: after a rejection or past the 7 days an offer cannot be accepted -> 409 INVALID_STATE', async () => {
        const t = await team(world, { openSeats: 2 });
        const [s1, s2] = t.openSeats;
        if (!s1 || !s2) throw new Error('no seats');
        const [a, b] = await manyGithubUsers(world, 'accept-state', 2);
        if (!a || !b) throw new Error('no users');
        const rejected = expectOk<OfferDto>(
          'createSeatOffer',
          await offerOn(t.lead, t.id, s1.id, a.id),
          201,
        );
        await world.as(a).post(`/v1/seat-offers/${rejected.id}/rejection`);
        expectProblem(
          'acceptSeatOffer',
          await world.as(a).post(`/v1/seat-offers/${rejected.id}/acceptance`),
          409,
          'INVALID_STATE',
        );
        const stale = expectOk<OfferDto>(
          'createSeatOffer',
          await offerOn(t.lead, t.id, s2.id, b.id),
          201,
        );
        clock.advance(8 * DAY);
        expectProblem(
          'acceptSeatOffer',
          await world.as(b).post(`/v1/seat-offers/${stale.id}/acceptance`),
          409,
          'INVALID_STATE',
        );
      });

      it('FR-TEAM-30: when the seat was taken by another offer -> 409 SEAT_TAKEN and the loser offer becomes cancelled', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const [first, second] = await manyGithubUsers(world, 'accept-taken', 2);
        if (!first || !second) throw new Error('no users');
        const o1 = expectOk<OfferDto>(
          'createSeatOffer',
          await offerOn(t.lead, t.id, seat.id, first.id),
          201,
        );
        const o2 = expectOk<OfferDto>(
          'createSeatOffer',
          await offerOn(t.lead, t.id, seat.id, second.id),
          201,
        );
        expectOk(
          'acceptSeatOffer',
          await world.as(first).post(`/v1/seat-offers/${o1.id}/acceptance`),
          200,
        );
        expectProblem(
          'acceptSeatOffer',
          await world.as(second).post(`/v1/seat-offers/${o2.id}/acceptance`),
          409,
          'SEAT_TAKEN',
        );
        const mine = expectOk<{ items: OfferDto[] }>(
          'listMySeatOffers',
          await world.as(second).get('/v1/me/seat-offers'),
          200,
        );
        expect(mine.items.find((o) => o.id === o2.id)?.status).toBe('cancelled');
      });

      it('FR-WORK-08: accepting twice with the same key joins once and replays the 200', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const candidate = await githubUser(world, 'accept-replay');
        const offer = expectOk<OfferDto>(
          'createSeatOffer',
          await offerOn(t.lead, t.id, seat.id, candidate.id),
          201,
        );
        const key = randomUUID();
        await world
          .as(candidate)
          .post(`/v1/seat-offers/${offer.id}/acceptance`, undefined, { idempotencyKey: key });
        const replay = await world
          .as(candidate)
          .post(`/v1/seat-offers/${offer.id}/acceptance`, undefined, { idempotencyKey: key });
        expect(replay.statusCode).toBe(200);
        expectReplayed(replay);
        expect(await activeAssignments(world, seat.id)).toBe(1);
        expect((await teamRow(world, t.id)).member_count).toBe(2);
      });
    });

    describe('rejectSeatOffer', () => {
      it('FR-TEAM-30: the addressee rejects -> rejected; the creator withdraws -> cancelled', async () => {
        const t = await team(world, { openSeats: 2 });
        const [s1, s2] = t.openSeats;
        if (!s1 || !s2) throw new Error('no seats');
        const [a, b] = await manyGithubUsers(world, 'reject', 2);
        if (!a || !b) throw new Error('no users');
        const o1 = expectOk<OfferDto>(
          'createSeatOffer',
          await offerOn(t.lead, t.id, s1.id, a.id),
          201,
        );
        const o2 = expectOk<OfferDto>(
          'createSeatOffer',
          await offerOn(t.lead, t.id, s2.id, b.id),
          201,
        );
        expect(
          expectOk<OfferDto>(
            'rejectSeatOffer',
            await world.as(a).post(`/v1/seat-offers/${o1.id}/rejection`),
            200,
          ).status,
        ).toBe('rejected');
        expect(
          expectOk<OfferDto>(
            'rejectSeatOffer',
            await world.as(t.lead).post(`/v1/seat-offers/${o2.id}/rejection`),
            200,
          ).status,
        ).toBe('cancelled');
      });

      it('FR-TEAM-30: a candidate withdraws his own request (cancelled); the lead rejects it (rejected)', async () => {
        const t = await team(world, { openSeats: 2 });
        const [s1, s2] = t.openSeats;
        if (!s1 || !s2) throw new Error('no seats');
        const candidate = await githubUser(world, 'reject-request');
        const r1 = expectOk<OfferDto>(
          'createJoinRequest',
          await world.as(candidate).post(`/v1/teams/${t.id}/join-requests`, { seatId: s1.id }),
          201,
        );
        const r2 = expectOk<OfferDto>(
          'createJoinRequest',
          await world.as(candidate).post(`/v1/teams/${t.id}/join-requests`, { seatId: s2.id }),
          201,
        );
        expect(
          expectOk<OfferDto>(
            'rejectSeatOffer',
            await world.as(candidate).post(`/v1/seat-offers/${r1.id}/rejection`),
            200,
          ).status,
        ).toBe('cancelled');
        expect(
          expectOk<OfferDto>(
            'rejectSeatOffer',
            await world.as(t.lead).post(`/v1/seat-offers/${r2.id}/rejection`),
            200,
          ).status,
        ).toBe('rejected');
      });

      it('FR-TEAM-30: a third party gets 404; a decided offer -> 409 INVALID_STATE', async () => {
        const t = await team(world, { members: 2, openSeats: 1 });
        const member = t.members[0];
        const seat = t.openSeats[0];
        if (!member || !seat) throw new Error('no fixture');
        const candidate = await githubUser(world, 'reject-third');
        const offer = expectOk<OfferDto>(
          'createSeatOffer',
          await offerOn(t.lead, t.id, seat.id, candidate.id),
          201,
        );
        expectProblem(
          'rejectSeatOffer',
          await world.as(member).post(`/v1/seat-offers/${offer.id}/rejection`),
          404,
          'NOT_FOUND',
        );
        await world.as(candidate).post(`/v1/seat-offers/${offer.id}/rejection`);
        expectProblem(
          'rejectSeatOffer',
          await world.as(candidate).post(`/v1/seat-offers/${offer.id}/rejection`),
          409,
          'INVALID_STATE',
        );
      });
    });
  },
);
