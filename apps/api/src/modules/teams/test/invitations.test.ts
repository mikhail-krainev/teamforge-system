import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { githubIdentity } from '../../../../test/fakes/github-server.js';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import {
  DAY,
  expectOk,
  githubUser,
  joinThroughOffer,
  team,
  userWithoutGithub,
  type InvitationDto,
  type OfferDto,
  type TeamFixture,
} from '../../../../test/fixtures/teams.js';
import {
  activeAssignments,
  activeInvitations,
  invitationRow,
  seatStatus,
} from '../../../../test/fixtures/teams-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

interface Created {
  invitation: InvitationDto;
  token: string;
}

interface JoinResult {
  teamId: string;
  seatId: string;
  joinedVia: string;
  trialUntil: string | null;
}

describeInfra('S3 teams: invitations (FR-TEAM-08, -09)', ['db', 'redis'], () => {
  let world: World;
  const clock = new FakeClock(Date.now());

  beforeAll(async () => {
    world = await startWorld({ clock, github: true });
  });

  afterAll(async () => {
    if (!world) return;
    await world.close();
  });

  async function invite(
    t: TeamFixture,
    body: Record<string, unknown> = {},
    seatIndex = 0,
  ): Promise<Created> {
    const seat = t.openSeats[seatIndex];
    if (!seat) throw new Error('no seat');
    const response = await world
      .as(t.lead)
      .post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id, ...body });
    return expectOk<Created>('createInvitation', response, 201);
  }

  describe('createInvitation', () => {
    it('FR-TEAM-08: a link invitation returns the token once; the database keeps only its SHA-256', async () => {
      const t = await team(world, { openSeats: 1 });
      const created = await invite(t);
      expect(created.token.length).toBeGreaterThanOrEqual(43);
      expect(created.invitation).toMatchObject({ status: 'active', seatId: t.openSeats[0]?.id });
      const row = await invitationRow(world, created.invitation.id);
      expect(row?.token_hash.toString('hex')).toBe(
        createHash('sha256').update(created.token).digest('hex'),
      );
      const dump = await world.sql<
        { t: string }[]
      >`SELECT i::text AS t FROM teams.invitation i WHERE id = ${created.invitation.id}`;
      expect(dump[0]?.t ?? '').not.toContain(created.token);
    });

    it('FR-TEAM-08: the invitation lives 7 days (C-12) and does not reserve the seat', async () => {
      const t = await team(world, { openSeats: 1 });
      const created = await invite(t);
      expect(Date.parse(created.invitation.expiresAt) - clock.now().getTime()).toBeGreaterThan(
        6.9 * DAY,
      );
      expect(Date.parse(created.invitation.expiresAt) - clock.now().getTime()).toBeLessThanOrEqual(
        7 * DAY + 5_000,
      );
      expect(await seatStatus(world, t.openSeats[0]?.id ?? '')).toBe('open');
    });

    it('FR-TEAM-08 (SEC-18): an e-mail invitation stores no address; inviteeHint is the string "email"', async () => {
      const t = await team(world, { openSeats: 1 });
      const address = `invited-${randomUUID().slice(0, 8)}@example.test`;
      const created = await invite(t, { inviteeEmail: address });
      expect(
        (created.invitation as InvitationDto & { inviteeHint: string | null }).inviteeHint,
      ).toBe('email');
      const dump = await world.sql<
        { t: string }[]
      >`SELECT i::text AS t FROM teams.invitation i WHERE id = ${created.invitation.id}`;
      expect(dump[0]?.t ?? '').not.toContain(address);
    });

    it('FR-TEAM-08 (SEC-18): an unknown GitHub login cannot be resolved -> 422', async () => {
      const t = await team(world, { openSeats: 1 });
      const seat = t.openSeats[0];
      if (!seat) throw new Error('no seat');
      const response = await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, {
        seatId: seat.id,
        inviteeGithubLogin: 'no-such-login-xyz',
      });
      // The login is resolved through GET /users/{login} on the GitHub double (github: true), never api.github.com.
      expect(response.statusCode, response.body).toBe(422);
    });

    describe('lookup of a GitHub login (S3SEC-02)', () => {
      const lookups = () =>
        (world.github?.requests ?? []).filter((r) => r.path.startsWith('/users/')).length;
      const known = (): string => {
        const identity = githubIdentity(`inv-${randomUUID().slice(0, 12)}`);
        world.github?.addUser(identity);
        return identity.login;
      };

      it('the second invitation of the same login is resolved from the cache, without a GitHub call', async () => {
        const t = await team(world, { openSeats: 1 });
        const login = known();
        const before = lookups();
        const first = await invite(t, { inviteeGithubLogin: login });
        const second = await invite(t, { inviteeGithubLogin: login.toUpperCase() });
        expect(first.invitation.id).not.toBe(second.invitation.id);
        expect(lookups() - before).toBe(1);
      });

      it('over the per-lead limit (10 per hour) -> 429 and GitHub is not asked', async () => {
        const t = await team(world, { openSeats: 1 });
        for (let i = 0; i < 10; i += 1) await invite(t, { inviteeGithubLogin: known() });
        const before = lookups();
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const response = await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, {
          seatId: seat.id,
          inviteeGithubLogin: known(),
        });
        expect(response.statusCode, response.body).toBe(429);
        expect(response.headers['retry-after']).toBeDefined();
        expect(lookups()).toBe(before);
      });

      it('a team at the limit C-13 gets 409 before any GitHub call', async () => {
        const t = await team(world, { openSeats: 1 });
        for (let i = 0; i < 20; i += 1) await invite(t);
        const before = lookups();
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        const response = await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, {
          seatId: seat.id,
          inviteeGithubLogin: known(),
        });
        expectProblem('createInvitation', response, 409, 'INVITATION_LIMIT');
        expect(lookups()).toBe(before);
      });
    });

    it('FR-TEAM-08: a seat that is not open -> 409 SEAT_NOT_OPEN', async () => {
      const t = await team(world, { openSeats: 1 });
      const seat = t.openSeats[0];
      if (!seat) throw new Error('no seat');
      const holder = await githubUser(world, 'invite-holder');
      await joinThroughOffer(world, t.lead, t.id, seat.id, holder);
      const response = await world
        .as(t.lead)
        .post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id });
      expectProblem('createInvitation', response, 409, 'SEAT_NOT_OPEN');
    });

    it('FR-TEAM-08: the 21st active invitation of a team -> 409 INVITATION_LIMIT (C-13)', async () => {
      const t = await team(world, { openSeats: 1 });
      for (let i = 0; i < 20; i += 1) await invite(t);
      const seat = t.openSeats[0];
      if (!seat) throw new Error('no seat');
      const over = await world
        .as(t.lead)
        .post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id });
      expectProblem('createInvitation', over, 409, 'INVITATION_LIMIT');
      expect(await activeInvitations(world, t.id)).toBe(20);
    });

    it('FR-TEAM-08: a member who is not the lead -> 403 NOT_TEAM_LEAD; a stranger -> 404; a seat of another team -> 404', async () => {
      const t = await team(world, { members: 2, openSeats: 1 });
      const other = await team(world, { openSeats: 1 });
      const member = t.members[0];
      const seat = t.openSeats[0];
      const foreignSeat = other.openSeats[0];
      if (!member || !seat || !foreignSeat) throw new Error('no fixture');
      const stranger = await githubUser(world, 'invite-stranger');
      expectProblem(
        'createInvitation',
        await world.as(member).post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }),
        403,
        'NOT_TEAM_LEAD',
      );
      expectProblem(
        'createInvitation',
        await world.as(stranger).post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        'createInvitation',
        await world.as(t.lead).post(`/v1/teams/${t.id}/invitations`, { seatId: foreignSeat.id }),
        404,
        'NOT_FOUND',
      );
    });

    it('FR-WORK-08: the same key creates one invitation and replays the same token', async () => {
      const t = await team(world, { openSeats: 1 });
      const seat = t.openSeats[0];
      if (!seat) throw new Error('no seat');
      const key = randomUUID();
      const first = await world
        .as(t.lead)
        .post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }, { idempotencyKey: key });
      const second = await world
        .as(t.lead)
        .post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }, { idempotencyKey: key });
      expect(second.statusCode).toBe(201);
      expectReplayed(second);
      expect(second.json<Created>().token).toBe(first.json<Created>().token);
      expect(await activeInvitations(world, t.id)).toBe(1);
    });

    it('S3CR-02: the plain token is never stored in idempotency_key; replay still returns it', async () => {
      const t = await team(world, { openSeats: 1 });
      const seat = t.openSeats[0];
      if (!seat) throw new Error('no seat');
      const key = randomUUID();
      const first = await world
        .as(t.lead)
        .post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }, { idempotencyKey: key });
      const token = first.json<Created>().token;
      const rows = await world.sql<{ response_body: unknown; response_provisional: boolean }[]>`
        SELECT response_body, response_provisional FROM platform.idempotency_key WHERE key = ${key}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.response_provisional).toBe(false);
      expect(JSON.stringify(rows[0]?.response_body)).not.toContain(token);
      const replay = await world
        .as(t.lead)
        .post(`/v1/teams/${t.id}/invitations`, { seatId: seat.id }, { idempotencyKey: key });
      expectReplayed(replay);
      expect(replay.json<Created>()).toEqual(first.json<Created>());
    });
  });

  describe('listInvitations and revokeInvitation', () => {
    it('FR-TEAM-08: the lead lists the invitations; the token is never part of the list', async () => {
      const t = await team(world, { openSeats: 1 });
      const created = await invite(t);
      const page = expectOk<{ items: InvitationDto[] }>(
        'listInvitations',
        await world.as(t.lead).get(`/v1/teams/${t.id}/invitations`),
        200,
      );
      expect(page.items.map((i) => i.id)).toContain(created.invitation.id);
      expect(JSON.stringify(page)).not.toContain(created.token);
    });

    it('FR-TEAM-08: a member who is not the lead -> 403; a stranger -> 404', async () => {
      const t = await team(world, { members: 2, openSeats: 1 });
      const member = t.members[0];
      if (!member) throw new Error('no member');
      const stranger = await githubUser(world, 'list-inv-stranger');
      expectProblem(
        'listInvitations',
        await world.as(member).get(`/v1/teams/${t.id}/invitations`),
        403,
        'NOT_TEAM_LEAD',
      );
      expectProblem(
        'listInvitations',
        await world.as(stranger).get(`/v1/teams/${t.id}/invitations`),
        404,
        'NOT_FOUND',
      );
    });

    it('FR-TEAM-08: a revoked invitation is gone (410) for preview and acceptance', async () => {
      const t = await team(world, { openSeats: 1 });
      const created = await invite(t);
      expectOk(
        'revokeInvitation',
        await world.as(t.lead).delete(`/v1/teams/${t.id}/invitations/${created.invitation.id}`),
        204,
      );
      const invitee = await githubUser(world, 'revoked-invitee');
      expectProblem(
        'previewInvitation',
        await world.as(invitee).post('/v1/invitation-previews', { token: created.token }),
        410,
        'INVITATION_GONE',
      );
      expectProblem(
        'acceptInvitation',
        await world.as(invitee).post('/v1/invitation-acceptances', { token: created.token }),
        410,
        'INVITATION_GONE',
      );
      expect((await invitationRow(world, created.invitation.id))?.status).toBe('revoked');
    });

    it('FR-TEAM-08: revoking twice -> 409 INVALID_STATE; an unknown invitation -> 404', async () => {
      const t = await team(world, { openSeats: 1 });
      const created = await invite(t);
      await world.as(t.lead).delete(`/v1/teams/${t.id}/invitations/${created.invitation.id}`);
      expectProblem(
        'revokeInvitation',
        await world.as(t.lead).delete(`/v1/teams/${t.id}/invitations/${created.invitation.id}`),
        409,
        'INVALID_STATE',
      );
      expectProblem(
        'revokeInvitation',
        await world.as(t.lead).delete(`/v1/teams/${t.id}/invitations/${randomUUID()}`),
        404,
        'NOT_FOUND',
      );
    });

    it('FR-TEAM-08: a member who is not the lead cannot revoke -> 403 NOT_TEAM_LEAD', async () => {
      const t = await team(world, { members: 2, openSeats: 1 });
      const member = t.members[0];
      if (!member) throw new Error('no member');
      const created = await invite(t);
      expectProblem(
        'revokeInvitation',
        await world.as(member).delete(`/v1/teams/${t.id}/invitations/${created.invitation.id}`),
        403,
        'NOT_TEAM_LEAD',
      );
      expect(await activeInvitations(world, t.id)).toBe(1);
    });
  });

  describe('previewInvitation', () => {
    it('FR-TEAM-09: shows team name, role, product type and expiry and changes nothing', async () => {
      const t = await team(world, { openSeats: 1, name: 'Preview team' });
      const created = await invite(t);
      const invitee = await githubUser(world, 'preview-invitee');
      const response = await world
        .as(invitee)
        .post('/v1/invitation-previews', { token: created.token });
      const preview = expectOk<{
        teamId: string;
        teamName: string;
        roleCode: string;
        productTypeCode: string;
        expiresAt: string;
      }>('previewInvitation', response, 200);
      expect(preview).toMatchObject({
        teamId: t.id,
        teamName: 'Preview team',
        roleCode: t.openSeats[0]?.roleCode,
        productTypeCode: 'web_service',
      });
      expect(Object.keys(preview).sort()).toEqual([
        'expiresAt',
        'productTypeCode',
        'roleCode',
        'teamId',
        'teamName',
      ]);
      expect((await invitationRow(world, created.invitation.id))?.status).toBe('active');
    });

    it('FR-TEAM-09: an unknown token -> 404 NOT_FOUND (no existence oracle for guesses)', async () => {
      const invitee = await githubUser(world, 'preview-unknown');
      const t = await team(world, { openSeats: 1 });
      const real = await invite(t);
      expectOk(
        'previewInvitation',
        await world.as(invitee).post('/v1/invitation-previews', { token: real.token }),
        200,
      );
      expectProblem(
        'previewInvitation',
        await world.as(invitee).post('/v1/invitation-previews', { token: 'Z'.repeat(43) }),
        404,
        'NOT_FOUND',
      );
    });

    it('FR-TEAM-09: a malformed token (too short) -> 400', async () => {
      const invitee = await githubUser(world, 'preview-short');
      expectProblem(
        'previewInvitation',
        await world.as(invitee).post('/v1/invitation-previews', { token: 'short' }),
        400,
        'VALIDATION_FAILED',
      );
    });

    it('FR-TEAM-09: an expired invitation -> 410 INVITATION_GONE', async () => {
      const t = await team(world, { openSeats: 1 });
      const created = await invite(t);
      clock.advance(8 * DAY);
      const invitee = await githubUser(world, 'preview-expired');
      expectProblem(
        'previewInvitation',
        await world.as(invitee).post('/v1/invitation-previews', { token: created.token }),
        410,
        'INVITATION_GONE',
      );
    });

    it('FR-TEAM-09: an invitation addressed to someone else -> 403 INVITATION_NOT_FOR_YOU', async () => {
      const t = await team(world, { openSeats: 1 });
      const address = world.email('preview-addressee');
      const created = await invite(t, { inviteeEmail: address });
      const other = await githubUser(world, 'preview-other');
      expectProblem(
        'previewInvitation',
        await world.as(other).post('/v1/invitation-previews', { token: created.token }),
        403,
        'INVITATION_NOT_FOR_YOU',
      );
    });

    it('FR-TEAM-09: guessing tokens is rate limited (RATE_LIMITED with Retry-After)', async () => {
      const guesser = await githubUser(world, 'preview-guesser');
      let limited = false;
      for (let i = 0; i < 300 && !limited; i += 1) {
        const response = await world.as(guesser).post('/v1/invitation-previews', {
          token: `${randomUUID()}${randomUUID()}`.slice(0, 43),
        });
        if (response.statusCode === 429) {
          expectProblem('previewInvitation', response, 429, 'RATE_LIMITED');
          expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1);
          limited = true;
        } else {
          expect(response.statusCode).toBe(404);
        }
      }
      expect(limited, 'a 429 within 300 guesses').toBe(true);
    });

    it('FR-AUTH-03: without a session -> 401', async () => {
      expectProblem(
        'previewInvitation',
        await world.anonymous().post('/v1/invitation-previews', { token: 'A'.repeat(43) }),
        401,
        'UNAUTHENTICATED',
      );
    });
  });

  describe('acceptInvitation', () => {
    it('FR-TEAM-09, -04: the invitee joins without a trial period; the invitation is used once', async () => {
      const t = await team(world, { openSeats: 1 });
      const created = await invite(t);
      const invitee = await githubUser(world, 'accept-invitee');
      const response = await world
        .as(invitee)
        .post('/v1/invitation-acceptances', { token: created.token });
      const joined = expectOk<JoinResult>('acceptInvitation', response, 200);
      expect(joined).toMatchObject({
        teamId: t.id,
        seatId: t.openSeats[0]?.id,
        joinedVia: 'invite',
        trialUntil: null,
      });
      const row = await invitationRow(world, created.invitation.id);
      expect(row).toMatchObject({ status: 'used', used_by: invitee.id });
      expect(await activeAssignments(world, t.openSeats[0]?.id ?? '')).toBe(1);
    });

    it('FR-TEAM-09: a used token cannot be used by a second person -> 410 INVITATION_GONE', async () => {
      const t = await team(world, { openSeats: 1 });
      const created = await invite(t);
      const [first, second] = [
        await githubUser(world, 'used-first'),
        await githubUser(world, 'used-second'),
      ];
      await world.as(first).post('/v1/invitation-acceptances', { token: created.token });
      expectProblem(
        'acceptInvitation',
        await world.as(second).post('/v1/invitation-acceptances', { token: created.token }),
        410,
        'INVITATION_GONE',
      );
    });

    it('FR-TEAM-09: after the 7 days -> 410 INVITATION_GONE', async () => {
      const t = await team(world, { openSeats: 1 });
      const created = await invite(t);
      clock.advance(8 * DAY);
      const invitee = await githubUser(world, 'accept-expired');
      expectProblem(
        'acceptInvitation',
        await world.as(invitee).post('/v1/invitation-acceptances', { token: created.token }),
        410,
        'INVITATION_GONE',
      );
    });

    it('FR-AUTH-05: an invitee without GitHub -> 409 GITHUB_REQUIRED and the invitation stays active', async () => {
      const t = await team(world, { openSeats: 1 });
      const created = await invite(t);
      const person = await userWithoutGithub(world, 'accept-no-github');
      expectProblem(
        'acceptInvitation',
        await world.as(person).post('/v1/invitation-acceptances', { token: created.token }),
        409,
        'GITHUB_REQUIRED',
      );
      expect((await invitationRow(world, created.invitation.id))?.status).toBe('active');
    });

    it('FR-TEAM-09: an invitation for another address -> 403 INVITATION_NOT_FOR_YOU', async () => {
      const t = await team(world, { openSeats: 1 });
      const created = await invite(t, { inviteeEmail: world.email('accept-addressee') });
      const other = await githubUser(world, 'accept-other');
      expectProblem(
        'acceptInvitation',
        await world.as(other).post('/v1/invitation-acceptances', { token: created.token }),
        403,
        'INVITATION_NOT_FOR_YOU',
      );
      expect((await invitationRow(world, created.invitation.id))?.status).toBe('active');
    });

    it('FR-TEAM-09: an e-mail invitation is accepted by the user with that normalized address', async () => {
      const t = await team(world, { openSeats: 1 });
      const invitee = await githubUser(world, 'accept-by-email');
      const created = await invite(t, { inviteeEmail: invitee.email.toUpperCase() });
      expectOk(
        'acceptInvitation',
        await world.as(invitee).post('/v1/invitation-acceptances', { token: created.token }),
        200,
      );
    });

    it('FR-TEAM-04: the seat taken meanwhile -> 409 SEAT_TAKEN; closed meanwhile -> 409 SEAT_NOT_OPEN', async () => {
      const t = await team(world, { openSeats: 2 });
      const [taken, closed] = t.openSeats;
      if (!taken || !closed) throw new Error('no seats');
      const a = await invite(t, {}, 0);
      const b = await invite(t, {}, 1);
      const holder = await githubUser(world, 'invite-holder-2');
      await joinThroughOffer(world, t.lead, t.id, taken.id, holder);
      await world.as(t.lead).delete(`/v1/teams/${t.id}/seats/${closed.id}`);
      const invitee = await githubUser(world, 'accept-race');
      expectProblem(
        'acceptInvitation',
        await world.as(invitee).post('/v1/invitation-acceptances', { token: a.token }),
        409,
        'SEAT_TAKEN',
      );
      expectProblem(
        'acceptInvitation',
        await world.as(invitee).post('/v1/invitation-acceptances', { token: b.token }),
        409,
        'SEAT_NOT_OPEN',
      );
    });

    it('FR-TEAM-05: a user in two active projects -> 409 PROJECT_LIMIT', async () => {
      const invitee = await githubUser(world, 'accept-limit');
      for (let i = 0; i < 2; i += 1) {
        const other = await team(world, { openSeats: 1 });
        const seat = other.openSeats[0];
        if (!seat) throw new Error('no seat');
        const offer = expectOk<OfferDto>(
          'createSeatOffer',
          await world
            .as(other.lead)
            .post(`/v1/teams/${other.id}/seat-offers`, { seatId: seat.id, userId: invitee.id }),
          201,
        );
        await world.as(invitee).post(`/v1/seat-offers/${offer.id}/acceptance`);
      }
      const t = await team(world, { openSeats: 1 });
      const created = await invite(t);
      expectProblem(
        'acceptInvitation',
        await world.as(invitee).post('/v1/invitation-acceptances', { token: created.token }),
        409,
        'PROJECT_LIMIT',
      );
    });

    it('FR-WORK-08: the same key joins once and replays the 200', async () => {
      const t = await team(world, { openSeats: 1 });
      const created = await invite(t);
      const invitee = await githubUser(world, 'accept-replay');
      const key = randomUUID();
      await world
        .as(invitee)
        .post('/v1/invitation-acceptances', { token: created.token }, { idempotencyKey: key });
      const replay = await world
        .as(invitee)
        .post('/v1/invitation-acceptances', { token: created.token }, { idempotencyKey: key });
      expect(replay.statusCode).toBe(200);
      expectReplayed(replay);
    });
  });
});
