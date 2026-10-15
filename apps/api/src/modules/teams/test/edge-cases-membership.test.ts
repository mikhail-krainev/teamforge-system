import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import {
  ballot,
  currentVote,
  DAY,
  expectOk,
  githubUser,
  joinThroughOffer,
  leaderVote,
  passDeadline,
  seatInput,
  team,
  type DepartureDto,
  type InvitationDto,
  type LeaderVoteFixture,
  type MemberDto,
  type OfferDto,
  type TeamDto,
  type VoteDto,
} from '../../../../test/fixtures/teams.js';
import {
  activeInvitations,
  activeMembershipsOf,
  activeMemberships,
  seatStatus,
  teamRow,
} from '../../../../test/fixtures/teams-db.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { expectCode, startWorld } from './support.js';

/**
 * S3-14: edge cases that the per-operation files do not reach (docs/plan.md, "Дополнение тестов").
 * The first half is edge-cases.test.ts; the concurrent variants live in apps/api/test/concurrency/edge-cases.test.ts.
 */
describeInfra(
  'S3 teams: edge cases of accounts, roles, invitations and status (S3-14)',
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

    const voteBase = (f: LeaderVoteFixture) => `/v1/teams/${f.team.id}/leader-votes/${f.voteId}`;
    const eligibleAt = (f: LeaderVoteFixture, i: number): UserFixture => {
      const m = f.eligible[i];
      if (!m) throw new Error(`no eligible member ${i}`);
      return m;
    };
    const setStatus = (user: UserFixture, status: 'active' | 'deleting' | 'deleted') =>
      world.sql`UPDATE auth."user" SET status = ${status} WHERE id = ${user.id}`;
    const rolesOf = (dto: TeamDto, userId: string): string[] =>
      dto.members.find((m: MemberDto) => m.userId === userId)?.roles ?? [];

    describe('an inactive account (FR-AUTH-09, FR-TEAM-28, -30)', () => {
      it('FR-TEAM-28: an offer to an unknown user -> 404; to an account that is being deleted -> 409 USER_INACTIVE', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('seat');
        expectProblem(
          'createSeatOffer',
          await world
            .as(t.lead)
            .post(`/v1/teams/${t.id}/seat-offers`, { seatId: seat.id, userId: randomUUID() }),
          404,
          'NOT_FOUND',
        );
        const leaving = await githubUser(world, 'inactive-target');
        await setStatus(leaving, 'deleting');
        expectProblem(
          'createSeatOffer',
          await world
            .as(t.lead)
            .post(`/v1/teams/${t.id}/seat-offers`, { seatId: seat.id, userId: leaving.id }),
          409,
          'USER_INACTIVE',
        );
        const gone = await githubUser(world, 'deleted-target');
        await setStatus(gone, 'deleted');
        expectProblem(
          'createSeatOffer',
          await world
            .as(t.lead)
            .post(`/v1/teams/${t.id}/seat-offers`, { seatId: seat.id, userId: gone.id }),
          409,
          'USER_INACTIVE',
        );
        expect(await seatStatus(world, seat.id)).toBe('open');
      });

      it('FR-AUTH-09: the account goes into deletion after the offer was made: accepting it -> 409 USER_INACTIVE, the seat stays open, no membership', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('seat');
        const candidate = await githubUser(world, 'deleting-addressee');
        const offer = expectOk<OfferDto>(
          'createSeatOffer',
          await world
            .as(t.lead)
            .post(`/v1/teams/${t.id}/seat-offers`, { seatId: seat.id, userId: candidate.id }),
          201,
        );
        await setStatus(candidate, 'deleting');
        const response = await world.as(candidate).post(`/v1/seat-offers/${offer.id}/acceptance`);
        expectCode(response, 409, 'USER_INACTIVE');
        expect(await seatStatus(world, seat.id)).toBe('open');
        expect(await activeMembershipsOf(world, candidate.id)).toBe(0);
        expect((await teamRow(world, t.id)).member_count).toBe(1);
        // the cancellation of the deletion (status back to active) makes the same offer usable again
        await setStatus(candidate, 'active');
        expectOk(
          'acceptSeatOffer',
          await world.as(candidate).post(`/v1/seat-offers/${offer.id}/acceptance`),
          200,
        );
      });

      it('FR-AUTH-09: a link invitation accepted by an account that is being deleted -> 409 USER_INACTIVE and the invitation stays active', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('seat');
        const created = expectOk<{ token: string; invitation: InvitationDto }>(
          'createInvitation',
          await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }),
          201,
        );
        const invitee = await githubUser(world, 'deleting-invitee');
        await setStatus(invitee, 'deleting');
        expectCode(
          await world.as(invitee).post('/v1/invitation-acceptances', { token: created.token }),
          409,
          'USER_INACTIVE',
        );
        expect(await activeInvitations(world, t.id)).toBe(1);
        expect(await seatStatus(world, seat.id)).toBe('open');
      });

      it('FR-AUTH-09: a join request by an account that is being deleted -> 409 USER_INACTIVE; the lead accepting an older request of such a user -> 409 USER_INACTIVE', async () => {
        const t = await team(world, { openSeats: 2 });
        const [first, second] = t.openSeats;
        if (!first || !second) throw new Error('seats');
        const requester = await githubUser(world, 'deleting-requester');
        const request = expectOk<OfferDto>(
          'createJoinRequest',
          await world.as(requester).post(`/v1/teams/${t.id}/join-requests`, { seatId: first.id }),
          201,
        );
        await setStatus(requester, 'deleting');
        expectCode(
          await world.as(requester).post(`/v1/teams/${t.id}/join-requests`, { seatId: second.id }),
          409,
          'USER_INACTIVE',
        );
        expectCode(
          await world.as(t.lead).post(`/v1/seat-offers/${request.id}/acceptance`),
          409,
          'USER_INACTIVE',
        );
        expect(await seatStatus(world, first.id)).toBe('open');
        expect(await activeMembershipsOf(world, requester.id)).toBe(0);
      });
    });

    describe('the second role of a member (C-03, FR-TEAM-07)', () => {
      it('FR-TEAM-07: a member with two roles is one member and one project: the count does not grow, both roles are listed', async () => {
        const t = await team(world, { members: 2, openSeats: 2 });
        const member = t.members[0];
        const second = t.openSeats[0];
        if (!member || !second) throw new Error('fixture');
        const before = (await teamRow(world, t.id)).member_count;
        await joinThroughOffer(world, t.lead, t.id, second.id, member);
        const dto = expectOk<TeamDto>(
          'getTeam',
          await world.as(t.lead).get(`/v1/teams/${t.id}`),
          200,
        );
        expect(rolesOf(dto, member.id).sort()).toEqual(
          [
            ...t.dto.seats.filter((s) => s.holderUserId === member.id).map((s) => s.roleCode),
            second.roleCode,
          ].sort(),
        );
        expect(rolesOf(dto, member.id)).toHaveLength(2);
        expect(dto.memberCount).toBe(before);
        expect(dto.members.filter((m) => m.userId === member.id)).toHaveLength(1);
        expect(await activeMemberships(world, t.id)).toBe(before);
        expect(await activeMembershipsOf(world, member.id)).toBe(1);
      });

      it('FR-TEAM-07, FR-TEAM-05: the second role is not a new project: a user in two projects can still take it in the second one', async () => {
        const home = await team(world, { members: 1, openSeats: 1 });
        const t = await team(world, { members: 1, openSeats: 3 });
        const [first, second] = t.openSeats;
        if (!first || !second) throw new Error('seats');
        const user = home.lead;
        await joinThroughOffer(world, t.lead, t.id, first.id, user);
        expect(await activeMembershipsOf(world, user.id)).toBe(2);
        // the third project would be refused ...
        const third = await team(world, { members: 1, openSeats: 1 });
        const refused = await world.as(third.lead).post(`/v1/teams/${third.id}/seat-offers`, {
          seatId: third.openSeats[0]?.id,
          userId: user.id,
        });
        const refusedOffer = expectOk<OfferDto>('createSeatOffer', refused, 201);
        expectProblem(
          'acceptSeatOffer',
          await world.as(user).post(`/v1/seat-offers/${refusedOffer.id}/acceptance`),
          409,
          'PROJECT_LIMIT',
        );
        // ... but a second role in the project he is already in is not
        await joinThroughOffer(world, t.lead, t.id, second.id, user);
        expect(await activeMembershipsOf(world, user.id)).toBe(2);
      });

      it('FR-TEAM-07: a second role through an invitation link works for a member; the same role again -> 409 ALREADY_MEMBER', async () => {
        const t = await team(world, { members: 2, openSeats: 1 });
        const member = t.members[0];
        const seat = t.openSeats[0];
        if (!member || !seat) throw new Error('fixture');
        const created = expectOk<{ token: string }>(
          'createInvitation',
          await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }),
          201,
        );
        const joined = expectOk<{ joinedVia: string; trialUntil: string | null }>(
          'acceptInvitation',
          await world.as(member).post('/v1/invitation-acceptances', { token: created.token }),
          200,
        );
        expect(joined.joinedVia).toBe('invite');
        const held = t.dto.seats.find((s) => s.holderUserId === member.id);
        const added = expectOk<{ items: { id: string }[] }>(
          'addSeats',
          await world.as(t.lead).post(`/v1/teams/${t.id}/seats`, {
            seats: [seatInput({ roleCode: held?.roleCode ?? 'backend' })],
          }),
          201,
        );
        const again = expectOk<OfferDto>(
          'createSeatOffer',
          await world.as(t.lead).post(`/v1/teams/${t.id}/seat-offers`, {
            seatId: added.items[0]?.id,
            userId: member.id,
          }),
          201,
        );
        expectProblem(
          'acceptSeatOffer',
          await world.as(member).post(`/v1/seat-offers/${again.id}/acceptance`),
          409,
          'ALREADY_MEMBER',
        );
      });

      it('FR-TEAM-11, -12: a member with two roles leaves: both seats open at once and one decision lists both', async () => {
        const t = await team(world, { members: 2, openSeats: 1 });
        const member = t.members[0];
        const extra = t.openSeats[0];
        if (!member || !extra) throw new Error('fixture');
        await joinThroughOffer(world, t.lead, t.id, extra.id, member);
        expectOk('leaveTeam', await world.as(member).delete(`/v1/teams/${t.id}/members/me`), 204);
        const dto = expectOk<TeamDto>(
          'getTeam',
          await world.as(t.lead).get(`/v1/teams/${t.id}`),
          200,
        );
        expect(dto.seats.filter((s) => s.status === 'open')).toHaveLength(2);
        expect(dto.memberCount).toBe(1);
        const departures = expectOk<{ items: DepartureDto[] }>(
          'listDepartures',
          await world.as(t.lead).get(`/v1/teams/${t.id}/departures`),
          200,
        );
        expect(departures.items).toHaveLength(1);
        expect(departures.items[0]?.seatIds).toHaveLength(2);
      });
    });

    describe('an invitation after it was revoked (FR-TEAM-08)', () => {
      const invite = async (t: { id: string; lead: UserFixture }, seatId: string) =>
        expectOk<{ token: string; invitation: InvitationDto }>(
          'createInvitation',
          await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, { seatId }),
          201,
        );

      it('FR-TEAM-08: a revoked token is dead for good: a new invitation for the same seat has a new token and the old one stays 410', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('seat');
        const first = await invite(t, seat.id);
        expectOk(
          'revokeInvitation',
          await world.as(t.lead).delete(`/v1/teams/${t.id}/invitations/${first.invitation.id}`),
          204,
        );
        const second = await invite(t, seat.id);
        expect(second.token).not.toBe(first.token);
        expect(second.invitation.id).not.toBe(first.invitation.id);
        const invitee = await githubUser(world, 'reuse-invitee');
        expectProblem(
          'acceptInvitation',
          await world.as(invitee).post('/v1/invitation-acceptances', { token: first.token }),
          410,
          'INVITATION_GONE',
        );
        expectOk(
          'acceptInvitation',
          await world.as(invitee).post('/v1/invitation-acceptances', { token: second.token }),
          200,
        );
        // the used and the revoked one both stay gone
        const other = await githubUser(world, 'reuse-other');
        expectProblem(
          'acceptInvitation',
          await world.as(other).post('/v1/invitation-acceptances', { token: first.token }),
          410,
          'INVITATION_GONE',
        );
      });

      it('FR-TEAM-08: a used invitation cannot be revoked -> 409 INVALID_STATE and stays used', async () => {
        const t = await team(world, { openSeats: 1 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('seat');
        const created = await invite(t, seat.id);
        const invitee = await githubUser(world, 'used-invitee');
        expectOk(
          'acceptInvitation',
          await world.as(invitee).post('/v1/invitation-acceptances', { token: created.token }),
          200,
        );
        expectProblem(
          'revokeInvitation',
          await world.as(t.lead).delete(`/v1/teams/${t.id}/invitations/${created.invitation.id}`),
          409,
          'INVALID_STATE',
        );
        const list = expectOk<{ items: InvitationDto[] }>(
          'listInvitations',
          await world.as(t.lead).get(`/v1/teams/${t.id}/invitations`),
          200,
        );
        expect(list.items.find((i) => i.id === created.invitation.id)?.status).toBe('used');
      });

      it('FR-TEAM-08 (C-13): revoking frees the slot: the 21st invitation is refused until one of the 20 is revoked', async () => {
        const t = await team(world, { members: 1, openSeats: 3 });
        const seat = t.openSeats[0];
        if (!seat) throw new Error('seat');
        const created: { token: string; invitation: InvitationDto }[] = [];
        for (let i = 0; i < 20; i += 1) created.push(await invite(t, seat.id));
        expectProblem(
          'createInvitation',
          await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }),
          409,
          'INVITATION_LIMIT',
        );
        const first = created[0];
        if (!first) throw new Error('created');
        expectOk(
          'revokeInvitation',
          await world.as(t.lead).delete(`/v1/teams/${t.id}/invitations/${first.invitation.id}`),
          204,
        );
        expect(await activeInvitations(world, t.id)).toBe(19);
        await invite(t, seat.id);
        expect(await activeInvitations(world, t.id)).toBe(20);
      });
    });

    describe('startProject in voting and suspended (FR-TEAM-10, -27)', () => {
      it('FR-TEAM-27: a forming team whose lead left is `voting`: nobody can start it (the former lead 404, a member 403); after the vote the new lead can', async () => {
        const t = await team(world, { members: 4, openSeats: 1 });
        expectOk('leaveTeam', await world.as(t.lead).delete(`/v1/teams/${t.id}/members/me`), 204);
        expect(await teamRow(world, t.id)).toMatchObject({ status: 'voting', lead_user_id: null });
        const [b, c] = t.members;
        if (!b || !c) throw new Error('members');
        // the former lead is not a member any more (404); a member is not the lead, and nobody is
        expectProblem(
          'startProject',
          await world.as(t.lead).post(`/v1/teams/${t.id}/start`),
          404,
          'NOT_FOUND',
        );
        expectProblem(
          'startProject',
          await world.as(b).post(`/v1/teams/${t.id}/start`),
          403,
          'NOT_TEAM_LEAD',
        );
        expect(await teamRow(world, t.id)).toMatchObject({ status: 'voting' });
        // b is elected: nominate, consent, two ballots out of 3 are a majority, b confirms
        const vote = await currentVote(world, b, t.id);
        const base = `/v1/teams/${t.id}/leader-votes/${vote.id}`;
        expectOk(
          'nominateCandidate',
          await world.as(b).post(`${base}/candidates`, { userId: b.id }),
          201,
        );
        expectOk(
          'consentCandidacy',
          await world.as(b).post(`${base}/candidates/${b.id}/consent`),
          200,
        );
        await passDeadline(world, b, t.id, DAY + 60_000);
        await ballot(world, t, vote.id, b, b);
        await ballot(world, t, vote.id, c, b);
        expectOk<VoteDto>(
          'respondLeaderOffer',
          await world.as(b).post(`${base}/offer-responses`, { accept: true }),
          200,
        );
        // the team is `forming` again (status before the vote) and the new lead may start it
        expect(await teamRow(world, t.id)).toMatchObject({ status: 'forming', lead_user_id: b.id });
        const started = expectOk<TeamDto>(
          'startProject',
          await world.as(b).post(`/v1/teams/${t.id}/start`),
          200,
        );
        expect(started.status).toBe('active');
      });

      it('FR-TEAM-27: a team suspended because nobody wants to lead (no_leader) cannot be started (former lead 404, member 403) and stays suspended', async () => {
        const f = await leaderVote(world, { phase: 'offering' });
        for (const m of f.eligible) {
          expect(
            (await world.as(m).post(`${voteBase(f)}/offer-responses`, { accept: false }))
              .statusCode,
          ).toBe(200);
        }
        expect((await teamRow(world, f.team.id)).status).toBe('suspended');
        expectProblem(
          'startProject',
          await world.as(f.formerLead).post(`/v1/teams/${f.team.id}/start`),
          404,
          'NOT_FOUND',
        );
        expectProblem(
          'startProject',
          await world.as(eligibleAt(f, 0)).post(`/v1/teams/${f.team.id}/start`),
          403,
          'NOT_TEAM_LEAD',
        );
        expect((await teamRow(world, f.team.id)).status).toBe('suspended');
      });

      it('FR-TEAM-10: starting a team in `suspended` by max duration for the lead -> 409 TEAM_STATUS_BLOCKS_ACTION and no second start entry', async () => {
        const t = await team(world, { status: 'active', openSeats: 1 });
        clock.advance(121 * DAY);
        await world.runMaintenance('max-duration-scan');
        await expectSuspended(t.id);
        expectProblem(
          'startProject',
          await world.as(t.lead).post(`/v1/teams/${t.id}/start`),
          409,
          'TEAM_STATUS_BLOCKS_ACTION',
        );
        const started = await world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM teams.team_event WHERE team_id = ${t.id} AND type = 'team_started'`;
        expect(started[0]?.n).toBe(1);
      });

      async function expectSuspended(teamId: string): Promise<void> {
        for (let i = 0; i < 100; i += 1) {
          if ((await teamRow(world, teamId)).status === 'suspended') return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('team did not become suspended');
      }
    });

    describe('the catalog and full teams (FR-TEAM-06, -26)', () => {
      it('FR-TEAM-06, -26: a team of 8 members is not listed even with an open seat; it is listed again when a member leaves', async () => {
        const t = await team(world, { members: 8, openSeats: 1 });
        const open = t.openSeats[0];
        if (!open) throw new Error('open seat');
        expect(t.dto.memberCount).toBe(8);
        const viewer = await githubUser(world, 'full-viewer');
        const listed = async (): Promise<string[]> =>
          expectOk<{ items: { id: string }[] }>(
            'listTeams',
            await world.as(viewer).get(`/v1/teams?role=${open.roleCode}&limit=100`),
            200,
          ).items.map((i) => i.id);
        expect(await listed()).not.toContain(t.id);
        // the same query without the role filter hides it too
        const all = expectOk<{ items: { id: string }[] }>(
          'listTeams',
          await world.as(viewer).get('/v1/teams?limit=100'),
          200,
        );
        expect(all.items.map((i) => i.id)).not.toContain(t.id);
        const leaver = t.members[0];
        if (!leaver) throw new Error('member');
        expectOk('leaveTeam', await world.as(leaver).delete(`/v1/teams/${t.id}/members/me`), 204);
        expect(await listed()).toContain(t.id);
      });

      it('FR-TEAM-06: the 8th member fills the team: it leaves the catalog at once, and an offer to the 9th person -> TEAM_FULL', async () => {
        const t = await team(world, { members: 7, openSeats: 2, roleCode: 'qa' });
        const [seatA, seatB] = t.openSeats;
        if (!seatA || !seatB) throw new Error('seats');
        const viewer = await githubUser(world, 'filling-viewer');
        const inCatalog = async (): Promise<boolean> =>
          expectOk<{ items: { id: string }[] }>(
            'listTeams',
            await world.as(viewer).get('/v1/teams?role=qa&limit=100'),
            200,
          ).items.some((i) => i.id === t.id);
        expect(await inCatalog()).toBe(true);
        const eighth = await githubUser(world, 'eighth');
        await joinThroughOffer(world, t.lead, t.id, seatA.id, eighth);
        expect(await inCatalog()).toBe(false);
        const ninth = await githubUser(world, 'ninth');
        const offer = expectOk<OfferDto>(
          'createSeatOffer',
          await world
            .as(t.lead)
            .post(`/v1/teams/${t.id}/seat-offers`, { seatId: seatB.id, userId: ninth.id }),
          201,
        );
        expectProblem(
          'acceptSeatOffer',
          await world.as(ninth).post(`/v1/seat-offers/${offer.id}/acceptance`),
          409,
          'TEAM_FULL',
        );
      });
    });
  },
);
