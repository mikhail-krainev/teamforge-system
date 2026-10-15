import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countOf, expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import {
  githubUser,
  expectOk,
  joinThroughOffer,
  seatInput,
  team,
  teamInput,
  userWithoutGithub,
  type TeamDto,
} from '../../../../test/fixtures/teams.js';
import { activeMemberships, teamRow } from '../../../../test/fixtures/teams-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

describeInfra(
  'S3 teams: create, read and update a team (FR-TEAM-01, -02, -05, -26, -27)',
  ['db', 'redis'],
  () => {
    let world: World;

    beforeAll(async () => {
      world = await startWorld();
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    describe('createTeam', () => {
      it('FR-TEAM-01: the creator becomes the lead and the only member of a forming team', async () => {
        const lead = await githubUser(world, 'create-lead');
        const response = await world
          .as(lead)
          .post('/v1/teams', teamInput({ seats: [seatInput()] }));
        const created = expectOk<TeamDto>('createTeam', response, 201);
        expect(created.status).toBe('forming');
        expect(created.leadUserId).toBe(lead.id);
        expect(created.memberCount).toBe(1);
        expect(created.members).toHaveLength(1);
        expect(created.members[0]).toMatchObject({
          userId: lead.id,
          isLead: true,
          status: 'active',
        });
        expect(response.headers.location).toContain(created.id);
        expect(await activeMemberships(world, created.id)).toBe(1);
        expect(await teamRow(world, created.id)).toMatchObject({ member_count: 1, seat_count: 1 });
      });

      it('FR-PLAY-03: the team is pinned to the latest published playbook of its product type', async () => {
        const lead = await githubUser(world, 'create-pinned');
        const created = expectOk<TeamDto>(
          'createTeam',
          await world.as(lead).post('/v1/teams', teamInput()),
          201,
        );
        // Slice 3 publishes a development stub 0.0.1 per product type (plan, "Решения по границам срезов").
        expect(created.playbookVersion).toBe('0.0.1');
        expect(created.playbookId).toMatch(/^[0-9a-f-]{36}$/);
        expect(created.productTypeCode).toBe('web_service');
      });

      it('FR-TEAM-02: seats of the request are created open, with ordinals per role, `count` expands', async () => {
        const lead = await githubUser(world, 'create-seats');
        const created = expectOk<TeamDto>(
          'createTeam',
          await world.as(lead).post(
            '/v1/teams',
            teamInput({
              seats: [seatInput({ count: 2 }), seatInput({ roleCode: 'frontend', desired: true })],
            }),
          ),
          201,
        );
        expect(created.seats).toHaveLength(3);
        expect(created.seats.every((s) => s.status === 'open' && s.holderUserId === null)).toBe(
          true,
        );
        const backend = created.seats.filter((s) => s.roleCode === 'backend').map((s) => s.ordinal);
        expect(backend.sort()).toEqual([1, 2]);
        expect(created.seats.find((s) => s.roleCode === 'frontend')?.desired).toBe(true);
      });

      it('FR-AUTH-05: without a linked GitHub account -> 409 GITHUB_REQUIRED and no team', async () => {
        const person = await userWithoutGithub(world, 'create-no-github');
        const response = await world.as(person).post('/v1/teams', teamInput());
        expectProblem('createTeam', response, 409, 'GITHUB_REQUIRED');
        expect(
          await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM teams.team WHERE created_by = ${person.id}`),
        ).toBe(0);
      });

      it('FR-TEAM-05: a user in two active projects cannot create a third -> 409 PROJECT_LIMIT', async () => {
        const lead = await githubUser(world, 'create-limit');
        for (let i = 0; i < 2; i += 1) {
          expectOk('createTeam', await world.as(lead).post('/v1/teams', teamInput()), 201);
        }
        const third = await world.as(lead).post('/v1/teams', teamInput());
        expectProblem('createTeam', third, 409, 'PROJECT_LIMIT');
      });

      it('FR-TEAM-02: more than 12 seats in total -> 422 SEAT_LIMIT (C-04)', async () => {
        const lead = await githubUser(world, 'create-seat-limit');
        const response = await world
          .as(lead)
          .post(
            '/v1/teams',
            teamInput({ seats: [seatInput({ count: 7 }), seatInput({ count: 6 })] }),
          );
        expectProblem('createTeam', response, 422, 'SEAT_LIMIT');
      });

      it.each([
        ['an unknown product type', { productTypeCode: 'no_such_type' }],
        ['an unknown role on a seat', { seats: [seatInput({ roleCode: 'no_such_role' })] }],
        ['an unknown time zone', { timezone: 'Mars/Phobos' }],
      ])('FR-TEAM-01: %s -> 422 and no team', async (_title, patch) => {
        const lead = await githubUser(world, 'create-422');
        const response = await world.as(lead).post('/v1/teams', teamInput(patch));
        expect(response.statusCode, response.body).toBe(422);
        expectProblem('createTeam', response, 422, response.json<{ code: string }>().code);
        expect(
          await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM teams.team WHERE created_by = ${lead.id}`),
        ).toBe(0);
      });

      it.each([
        ['a name shorter than 3 characters', { name: 'ab' }],
        ['hoursPerWeek below 3', { hoursPerWeek: 2 }],
        ['a missing description', { description: undefined }],
      ])('FR-TEAM-01: %s -> 400 VALIDATION_FAILED', async (_title, patch) => {
        const lead = await githubUser(world, 'create-400');
        const response = await world.as(lead).post('/v1/teams', teamInput(patch));
        const problem = expectProblem('createTeam', response, 400, 'VALIDATION_FAILED');
        expect(problem.errors?.length).toBeGreaterThan(0);
      });

      it('FR-WORK-08: a request without Idempotency-Key -> 400 IDEMPOTENCY_KEY_MISSING', async () => {
        const lead = await githubUser(world, 'create-nokey');
        const response = await world
          .as(lead)
          .post('/v1/teams', teamInput(), { idempotencyKey: null });
        expectProblem('createTeam', response, 400, 'IDEMPOTENCY_KEY_MISSING');
      });

      it('FR-WORK-08: the same key twice creates one team and replays the stored answer', async () => {
        const lead = await githubUser(world, 'create-replay');
        const key = randomUUID();
        const body = teamInput();
        const first = await world.as(lead).post('/v1/teams', body, { idempotencyKey: key });
        const created = expectOk<TeamDto>('createTeam', first, 201);
        const second = await world.as(lead).post('/v1/teams', body, { idempotencyKey: key });
        expect(second.statusCode).toBe(201);
        expectReplayed(second);
        expect(second.json<TeamDto>().id).toBe(created.id);
        expect(
          await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM teams.team WHERE created_by = ${lead.id}`),
        ).toBe(1);
      });

      it('FR-WORK-08: the same key with another body -> 422 IDEMPOTENCY_KEY_REUSED', async () => {
        const lead = await githubUser(world, 'create-reuse');
        const key = randomUUID();
        await world.as(lead).post('/v1/teams', teamInput(), { idempotencyKey: key });
        const other = await world
          .as(lead)
          .post('/v1/teams', teamInput({ name: 'Another name' }), { idempotencyKey: key });
        expectProblem('createTeam', other, 422, 'IDEMPOTENCY_KEY_REUSED');
      });

      it('FR-AUTH-03: without a session -> 401 UNAUTHENTICATED', async () => {
        expectProblem(
          'createTeam',
          await world.anonymous().post('/v1/teams', teamInput()),
          401,
          'UNAUTHENTICATED',
        );
      });
    });

    describe('getTeam', () => {
      it('FR-TEAM-02, FR-TEAM-27: any signed-in user sees the card with seats, members and status', async () => {
        const t = await team(world, { members: 2, openSeats: 1 });
        const stranger = await githubUser(world, 'get-stranger');
        const dto = expectOk<TeamDto>(
          'getTeam',
          await world.as(stranger).get(`/v1/teams/${t.id}`),
          200,
        );
        expect(dto.status).toBe('forming');
        expect(dto.memberCount).toBe(2);
        expect(dto.seats.filter((s) => s.status === 'open')).toHaveLength(1);
        expect(dto.seats.filter((s) => s.status === 'filled')).toHaveLength(1);
      });

      it('FR-TEAM-02: private fields of the members are not returned (e-mail, GitHub id)', async () => {
        const t = await team(world, { members: 2, openSeats: 1 });
        const stranger = await githubUser(world, 'get-private');
        const response = await world.as(stranger).get(`/v1/teams/${t.id}`);
        for (const secret of [
          t.lead.email,
          t.members[0]?.email ?? '',
          'githubUserId',
          'github_user_id',
          'email',
        ]) {
          expect(response.body, secret).not.toContain(secret);
        }
      });

      it('FR-TEAM-02: an unknown team -> 404 NOT_FOUND', async () => {
        const person = await githubUser(world, 'get-unknown');
        const existing = await team(world);
        expectOk('getTeam', await world.as(person).get(`/v1/teams/${existing.id}`), 200);
        expectProblem(
          'getTeam',
          await world.as(person).get(`/v1/teams/${randomUUID()}`),
          404,
          'NOT_FOUND',
        );
      });

      it('FR-TEAM-02: a malformed team id -> 400', async () => {
        const person = await githubUser(world, 'get-malformed');
        expectProblem(
          'getTeam',
          await world.as(person).get('/v1/teams/not-a-uuid'),
          400,
          'VALIDATION_FAILED',
        );
      });
    });

    describe('updateTeam', () => {
      it('FR-TEAM-01: the lead changes the card and the version grows', async () => {
        const t = await team(world);
        const response = await world.as(t.lead).patch(`/v1/teams/${t.id}`, {
          name: 'A better name',
          hoursPerWeek: 20,
          version: t.dto.version,
        });
        const dto = expectOk<TeamDto>('updateTeam', response, 200);
        expect(dto).toMatchObject({ name: 'A better name', hoursPerWeek: 20 });
        expect(dto.version).toBe(t.dto.version + 1);
      });

      it('FR-TEAM-01: a stale version -> 409 VERSION_CONFLICT with the current state', async () => {
        const t = await team(world);
        await world
          .as(t.lead)
          .patch(`/v1/teams/${t.id}`, { name: 'First change', version: t.dto.version });
        const stale = await world
          .as(t.lead)
          .patch(`/v1/teams/${t.id}`, { name: 'Second change', version: t.dto.version });
        const problem = expectProblem('updateTeam', stale, 409, 'VERSION_CONFLICT');
        expect(problem.current).toMatchObject({ name: 'First change' });
        expect((await teamRow(world, t.id)).version).toBe(t.dto.version + 1);
      });

      it('FR-TEAM-01: a body without version -> 400 VERSION_MISSING', async () => {
        const t = await team(world);
        const response = await world
          .as(t.lead)
          .patch(`/v1/teams/${t.id}`, { name: 'No version here' });
        expectProblem('updateTeam', response, 400, 'VERSION_MISSING');
      });

      it('FR-TEAM-01: an unknown time zone -> 422', async () => {
        const t = await team(world);
        const response = await world
          .as(t.lead)
          .patch(`/v1/teams/${t.id}`, { timezone: 'Mars/Phobos', version: t.dto.version });
        expect(response.statusCode, response.body).toBe(422);
      });

      it('FR-TEAM-01: a member who is not the lead -> 403 NOT_TEAM_LEAD, nothing changes', async () => {
        const t = await team(world, { members: 2 });
        const member = t.members[0];
        if (!member) throw new Error('no member');
        const response = await world
          .as(member)
          .patch(`/v1/teams/${t.id}`, { name: 'Hijacked', version: t.dto.version });
        expectProblem('updateTeam', response, 403, 'NOT_TEAM_LEAD');
        expect((await teamRow(world, t.id)).version).toBe(t.dto.version);
      });

      it('FR-TEAM-01: a user outside the team gets 404, not 403', async () => {
        const t = await team(world);
        const stranger = await githubUser(world, 'update-stranger');
        const response = await world
          .as(stranger)
          .patch(`/v1/teams/${t.id}`, { name: 'Hijacked', version: 1 });
        expectProblem('updateTeam', response, 404, 'NOT_FOUND');
      });
    });

    describe('listTeams (catalog)', () => {
      it('FR-TEAM-26: the catalog lists teams with their open seats and the filters narrow it down', async () => {
        const marker = `catalog-${randomUUID().slice(0, 6)}`;
        const lead = await githubUser(world, marker);
        const created = expectOk<TeamDto>(
          'createTeam',
          await world.as(lead).post(
            '/v1/teams',
            teamInput({
              name: marker,
              seats: [seatInput({ roleCode: 'devops', minLevel: 'middle' })],
            }),
          ),
          201,
        );
        const viewer = await githubUser(world, 'catalog-viewer');
        const byRole = await world.as(viewer).get('/v1/teams?role=devops&limit=100');
        const page = expectOk<{
          items: { id: string; openSeats: { roleCode: string; minLevel: string }[] }[];
          nextCursor: string | null;
        }>('listTeams', byRole, 200);
        const found = page.items.find((i) => i.id === created.id);
        expect(found?.openSeats).toEqual([
          expect.objectContaining({ roleCode: 'devops', minLevel: 'middle' }),
        ]);

        const other = await world
          .as(viewer)
          .get('/v1/teams?role=designer&productType=ml_product&limit=100');
        expect(
          expectOk<{ items: { id: string }[] }>('listTeams', other, 200).items.map((i) => i.id),
        ).not.toContain(created.id);
      });

      it('FR-TEAM-26: a team without an open seat of the requested role is hidden from that filter', async () => {
        const t = await team(world, { members: 2, openSeats: 0 });
        const viewer = await githubUser(world, 'catalog-hidden');
        const role = t.dto.seats[0]?.roleCode ?? 'backend';
        const page = expectOk<{ items: { id: string }[] }>(
          'listTeams',
          await world.as(viewer).get(`/v1/teams?role=${role}&limit=100`),
          200,
        );
        expect(page.items.map((i) => i.id)).not.toContain(t.id);
      });

      it('FR-TEAM-26: pages are cursor based (C-40): limit=1 gives a cursor that leads to a different team', async () => {
        await team(world, { openSeats: 1 });
        await team(world, { openSeats: 1 });
        const viewer = await githubUser(world, 'catalog-pages');
        const first = expectOk<{ items: { id: string }[]; nextCursor: string | null }>(
          'listTeams',
          await world.as(viewer).get('/v1/teams?limit=1'),
          200,
        );
        expect(first.items).toHaveLength(1);
        expect(first.nextCursor).not.toBeNull();
        const second = expectOk<{ items: { id: string }[] }>(
          'listTeams',
          await world
            .as(viewer)
            .get(`/v1/teams?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? '')}`),
          200,
        );
        expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
      });

      it('FR-TEAM-26: only forming and active teams are listed; status=active narrows to started ones', async () => {
        const started = await team(world, { status: 'active', openSeats: 1 });
        const forming = await team(world, { openSeats: 1 });
        const viewer = await githubUser(world, 'catalog-status');
        const page = expectOk<{ items: { id: string; status: string }[] }>(
          'listTeams',
          await world.as(viewer).get('/v1/teams?status=active&limit=100'),
          200,
        );
        const ids = page.items.map((i) => i.id);
        expect(ids).toContain(started.id);
        expect(ids).not.toContain(forming.id);
        expect(page.items.every((i) => i.status === 'active')).toBe(true);
      });

      it('FR-TEAM-26: an invalid filter value -> 400', async () => {
        const viewer = await githubUser(world, 'catalog-bad');
        expectProblem(
          'listTeams',
          await world.as(viewer).get('/v1/teams?status=archived'),
          400,
          'VALIDATION_FAILED',
        );
        expectProblem(
          'listTeams',
          await world.as(viewer).get('/v1/teams?limit=1000'),
          400,
          'VALIDATION_FAILED',
        );
      });

      it('FR-AUTH-03: without a session -> 401', async () => {
        expectProblem(
          'listTeams',
          await world.anonymous().get('/v1/teams'),
          401,
          'UNAUTHENTICATED',
        );
      });
    });

    describe('listMyTeams', () => {
      it('FR-TEAM-05: lists the caller teams with roles and the lead flag; the other teams are absent', async () => {
        const t = await team(world, { members: 2, openSeats: 1 });
        const member = t.members[0];
        if (!member) throw new Error('no member');
        const mine = expectOk<{
          items: {
            team: { id: string };
            isLead: boolean;
            myRoles: string[];
            membershipStatus: string;
          }[];
        }>('listMyTeams', await world.as(member).get('/v1/me/teams?status=current'), 200);
        expect(mine.items).toHaveLength(1);
        expect(mine.items[0]).toMatchObject({ isLead: false, membershipStatus: 'active' });
        expect(mine.items[0]?.team.id).toBe(t.id);
        expect(mine.items[0]?.myRoles).toHaveLength(1);
        const lead = expectOk<{ items: { team: { id: string }; isLead: boolean }[] }>(
          'listMyTeams',
          await world.as(t.lead).get('/v1/me/teams'),
          200,
        );
        expect(lead.items[0]).toMatchObject({ isLead: true });
      });

      it('FR-TEAM-11: after leaving, the team moves from `current` to `past`', async () => {
        const t = await team(world, { members: 2, openSeats: 1 });
        const member = t.members[0];
        if (!member) throw new Error('no member');
        expectOk('leaveTeam', await world.as(member).delete(`/v1/teams/${t.id}/members/me`), 204);
        const current = expectOk<{ items: { team: { id: string } }[] }>(
          'listMyTeams',
          await world.as(member).get('/v1/me/teams?status=current'),
          200,
        );
        const past = expectOk<{ items: { team: { id: string }; membershipStatus: string }[] }>(
          'listMyTeams',
          await world.as(member).get('/v1/me/teams?status=past'),
          200,
        );
        expect(current.items.map((i) => i.team.id)).not.toContain(t.id);
        expect(past.items.find((i) => i.team.id === t.id)?.membershipStatus).toBe('left');
      });

      it('FR-TEAM-05: a user with no teams gets an empty page', async () => {
        const person = await githubUser(world, 'my-teams-empty');
        const page = expectOk<{ items: unknown[]; nextCursor: string | null }>(
          'listMyTeams',
          await world.as(person).get('/v1/me/teams'),
          200,
        );
        expect(page).toEqual({ items: [], nextCursor: null });
      });

      it('FR-TEAM-05: a joined member sees the team in `current` right after the offer was accepted', async () => {
        const t = await team(world, { openSeats: 1 });
        const candidate = await githubUser(world, 'my-teams-join');
        const seat = t.openSeats[0];
        if (!seat) throw new Error('no seat');
        await joinThroughOffer(world, t.lead, t.id, seat.id, candidate);
        const page = expectOk<{ items: { team: { id: string } }[] }>(
          'listMyTeams',
          await world.as(candidate).get('/v1/me/teams?status=current'),
          200,
        );
        expect(page.items.map((i) => i.team.id)).toEqual([t.id]);
      });
    });
  },
);
