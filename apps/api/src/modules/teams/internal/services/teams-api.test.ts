import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { expectProblem, expectReplayed } from '../../../../../test/fixtures/assertions.js';
import type { UserFixture } from '../../../../../test/fixtures/index.js';
import { World } from '../../../../../test/fixtures/world.js';
import { githubIdentity } from '../../../../../test/fakes/github-server.js';
import { expectMatchesContract } from '../../../../../test/helpers/contract.js';
import { describeInfra } from '../../../../../test/helpers/infra.js';

interface SeatBody {
  id: string;
  roleCode: string;
  ordinal: number;
  desired: boolean;
  status: string;
  version: number;
  holderUserId: string | null;
  desiredChangedAt: string | null;
}

interface TeamBody {
  id: string;
  name: string;
  status: string;
  leadUserId: string;
  playbookVersion: string;
  memberCount: number;
  version: number;
  seats: SeatBody[];
  members: { userId: string; roles: string[]; isLead: boolean; trialUntil: string | null }[];
}

const seatInput = (roleCode: string, extra: Record<string, unknown> = {}) => ({
  roleCode,
  desired: false,
  minLevel: 'junior',
  minHours: 10,
  stack: [],
  ...extra,
});

const teamInput = (extra: Record<string, unknown> = {}) => ({
  name: 'Team Forge',
  description: 'A team',
  timezone: 'Europe/Moscow',
  hoursPerWeek: 10,
  productTypeCode: 'web_service',
  ...extra,
});

describeInfra('S3-03 teams and seats (FR-TEAM-01..06)', ['db', 'redis'], () => {
  let world: World;
  const label = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 6)}`;

  beforeAll(async () => {
    world = await World.start({ worker: false });
    await world.ensureCatalog(['backend', 'frontend', 'qa'], ['ts', 'react']);
  });

  afterAll(async () => {
    await world?.close();
  });

  async function person(prefix: string, withGithub = true): Promise<UserFixture> {
    const name = label(prefix);
    return world.createUser(name, withGithub ? { github: githubIdentity(name) } : {});
  }

  async function createTeam(
    user: UserFixture,
    extra: Record<string, unknown> = {},
  ): Promise<TeamBody> {
    const response = await world.as(user).post('/v1/teams', teamInput(extra));
    expect(response.statusCode, response.body).toBe(201);
    return response.json<TeamBody>();
  }

  const count = async (query: Promise<{ n: number }[]>): Promise<number> =>
    (await query)[0]?.n ?? NaN;

  it('FR-TEAM-01: createTeam makes the creator lead and member of a forming team, pins the playbook', async () => {
    const lead = await person('lead');
    const response = await world
      .as(lead)
      .post('/v1/teams', teamInput({ seats: [seatInput('backend', { count: 2 })] }));
    expect(response.statusCode, response.body).toBe(201);
    expectMatchesContract('createTeam', response);
    const team = response.json<TeamBody>();
    expect(response.headers.location).toBe(`/api/v1/teams/${team.id}`);
    expect(team).toMatchObject({
      status: 'forming',
      leadUserId: lead.id,
      memberCount: 1,
      playbookVersion: '0.0.1',
    });
    expect(team.members).toHaveLength(1);
    expect(team.members[0]).toMatchObject({ userId: lead.id, isLead: true, roles: [] });
    expect(team.seats.map((s) => [s.roleCode, s.ordinal, s.status])).toEqual([
      ['backend', 1, 'open'],
      ['backend', 2, 'open'],
    ]);
    const rows = await world.sql<{ seat_count: number; joined_via: string }[]>`
      SELECT t.seat_count, m.joined_via FROM teams.team t JOIN teams.membership m ON m.team_id = t.id
      WHERE t.id = ${team.id}`;
    expect(rows).toEqual([{ seat_count: 2, joined_via: 'creator' }]);
    const journal = await world.sql<{ type: string }[]>`
      SELECT type FROM teams.team_event WHERE team_id = ${team.id} ORDER BY type`;
    expect(journal.map((e) => e.type)).toEqual(['seat_opened', 'seat_opened', 'team_created']);
    const outbox = await world.sql<{ type: string }[]>`
      SELECT type FROM platform.outbox_event WHERE module = 'teams'
        AND (payload->>'teamId') = ${team.id} ORDER BY type`;
    expect(outbox.map((e) => e.type)).toEqual(['seat_opened', 'seat_opened', 'team_created']);
  });

  it('FR-TEAM-01: a repeated request with the same Idempotency-Key replays the answer, no second team', async () => {
    const lead = await person('idem');
    const key = randomUUID();
    const first = await world.as(lead).post('/v1/teams', teamInput(), { idempotencyKey: key });
    const second = await world.as(lead).post('/v1/teams', teamInput(), { idempotencyKey: key });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expectReplayed(second);
    expect(second.json<TeamBody>().id).toBe(first.json<TeamBody>().id);
    const n = await count(
      world.sql`SELECT count(*)::int AS n FROM teams.team WHERE created_by = ${lead.id}`,
    );
    expect(n).toBe(1);
  });

  it('FR-AUTH-05: createTeam without a linked GitHub account is 409 GITHUB_REQUIRED', async () => {
    const user = await person('nogh', false);
    const response = await world.as(user).post('/v1/teams', teamInput());
    expectProblem('createTeam', response, 409, 'GITHUB_REQUIRED');
  });

  it('FR-TEAM-05: the third active project is 409 PROJECT_LIMIT; a completed team frees the slot', async () => {
    const user = await person('limit');
    const first = await createTeam(user);
    await createTeam(user);
    expectProblem(
      'createTeam',
      await world.as(user).post('/v1/teams', teamInput()),
      409,
      'PROJECT_LIMIT',
    );
    await world.sql`UPDATE teams.team SET status = 'completed' WHERE id = ${first.id}`;
    expect((await world.as(user).post('/v1/teams', teamInput())).statusCode).toBe(201);
  });

  it('FR-TEAM-02: createTeam rejects more than 12 seats (SEAT_LIMIT), unknown roles, tags, product types and zones', async () => {
    const user = await person('invalid');
    const caller = world.as(user);
    const tooMany = await caller.post(
      '/v1/teams',
      teamInput({ seats: [seatInput('backend', { count: 12 }), seatInput('qa')] }),
    );
    expectProblem('createTeam', tooMany, 422, 'SEAT_LIMIT');
    const role = expectProblem(
      'createTeam',
      await caller.post('/v1/teams', teamInput({ seats: [seatInput('nonexistent')] })),
      422,
      'VALIDATION_FAILED',
    );
    expect(role.errors?.[0]?.pointer).toBe('/seats/0/roleCode');
    const tag = expectProblem(
      'createTeam',
      await caller.post(
        '/v1/teams',
        teamInput({ seats: [seatInput('qa', { stack: ['ts', 'nope'] })] }),
      ),
      422,
      'VALIDATION_FAILED',
    );
    expect(tag.errors?.[0]?.pointer).toBe('/seats/0/stack/1');
    const type = expectProblem(
      'createTeam',
      await caller.post('/v1/teams', teamInput({ productTypeCode: 'unknown_type' })),
      422,
      'VALIDATION_FAILED',
    );
    expect(type.errors?.[0]?.pointer).toBe('/productTypeCode');
    const zone = expectProblem(
      'createTeam',
      await caller.post('/v1/teams', teamInput({ timezone: 'Mars/Base' })),
      422,
      'VALIDATION_FAILED',
    );
    expect(zone.errors?.[0]?.pointer).toBe('/timezone');
    const n = await count(
      world.sql`SELECT count(*)::int AS n FROM teams.team WHERE created_by = ${user.id}`,
    );
    expect(n).toBe(0);
  });

  it('FR-TEAM-02: addSeats continues ordinals, keeps C-04 (12) and tells the lead from others', async () => {
    const lead = await person('seats');
    const team = await createTeam(lead, { seats: [seatInput('backend')] });
    const added = await world.as(lead).post(`/v1/teams/${team.id}/seats`, {
      seats: [seatInput('backend', { count: 2, desired: true }), seatInput('qa')],
    });
    expect(added.statusCode, added.body).toBe(201);
    expectMatchesContract('addSeats', added);
    const items = added.json<{ items: SeatBody[] }>().items;
    expect(items.map((s) => [s.roleCode, s.ordinal])).toEqual([
      ['backend', 2],
      ['backend', 3],
      ['qa', 1],
    ]);
    expect(items.filter((s) => s.desired).every((s) => s.desiredChangedAt !== null)).toBe(true);
    const over = await world
      .as(lead)
      .post(`/v1/teams/${team.id}/seats`, { seats: [seatInput('qa', { count: 9 })] });
    expectProblem('addSeats', over, 422, 'SEAT_LIMIT');
    const fits = await world
      .as(lead)
      .post(`/v1/teams/${team.id}/seats`, { seats: [seatInput('qa', { count: 8 })] });
    expect(fits.statusCode, fits.body).toBe(201);
    const n = await count(
      world.sql`SELECT seat_count::int AS n FROM teams.team WHERE id = ${team.id}`,
    );
    expect(n).toBe(12);

    const other = await person('seats-other');
    expectProblem(
      'addSeats',
      await world.as(other).post(`/v1/teams/${team.id}/seats`, { seats: [seatInput('qa')] }),
      404,
      'NOT_FOUND',
    );
  });

  it('FR-TEAM-03: updateSeat toggles desired with a journal row and desired_changed_at; stale version is 409 with current', async () => {
    const lead = await person('desired');
    const team = await createTeam(lead, { seats: [seatInput('backend'), seatInput('qa')] });
    const seat = team.seats[0] as SeatBody;
    const url = `/v1/teams/${team.id}/seats/${seat.id}`;
    const response = await world
      .as(lead)
      .patch(url, { version: seat.version, desired: true, minHours: 20 });
    expect(response.statusCode, response.body).toBe(200);
    expectMatchesContract('updateSeat', response);
    const updated = response.json<SeatBody & { minHours: number }>();
    expect(updated).toMatchObject({ desired: true, minHours: 20, version: seat.version + 1 });
    expect(updated.desiredChangedAt).not.toBeNull();

    const stale = await world.as(lead).patch(url, { version: seat.version, desired: false });
    const problem = expectProblem('updateSeat', stale, 409, 'VERSION_CONFLICT');
    expect(problem.current).toMatchObject({
      id: seat.id,
      version: seat.version + 1,
      desired: true,
    });

    const journal = await world.sql<{ type: string; payload: Record<string, unknown> }[]>`
      SELECT type, payload FROM teams.team_event
      WHERE team_id = ${team.id} AND payload->>'seatId' = ${seat.id} AND type <> 'seat_opened' ORDER BY type`;
    expect(journal.map((e) => e.type)).toEqual(['seat_desired_changed', 'seat_updated']);
    expect(journal[0]?.payload).toMatchObject({ from: false, to: true });

    const same = await world.as(lead).patch(url, { version: seat.version + 1, desired: true });
    expect(same.json<SeatBody>().version).toBe(seat.version + 1);
    const tag = await world.as(lead).patch(url, { version: seat.version + 1, stack: ['nope'] });
    expectProblem('updateSeat', tag, 422, 'VALIDATION_FAILED');
  });

  it('FR-TEAM-02: closeSeat closes only an open seat (409 INVALID_STATE otherwise) and frees a place', async () => {
    const lead = await person('close');
    const team = await createTeam(lead, { seats: [seatInput('backend'), seatInput('qa')] });
    const [open, filled] = team.seats as [SeatBody, SeatBody];
    const holder = await person('holder');
    await world.sql`UPDATE teams.seat SET status = 'filled' WHERE id = ${filled.id}`;
    await world.sql`
      INSERT INTO teams.membership (id, team_id, user_id, status, joined_via, joined_at)
      VALUES (${randomUUID()}, ${team.id}, ${holder.id}, 'active', 'offer', now())`;

    const closed = await world.as(lead).delete(`/v1/teams/${team.id}/seats/${open.id}`);
    expect(closed.statusCode, closed.body).toBe(204);
    expectProblem(
      'closeSeat',
      await world.as(lead).delete(`/v1/teams/${team.id}/seats/${open.id}`),
      409,
      'INVALID_STATE',
    );
    expectProblem(
      'closeSeat',
      await world.as(lead).delete(`/v1/teams/${team.id}/seats/${filled.id}`),
      409,
      'INVALID_STATE',
    );

    const foreign = await createTeam(await person('close-foreign'), { seats: [seatInput('qa')] });
    const foreignSeat = foreign.seats[0] as SeatBody;
    expectProblem(
      'closeSeat',
      await world.as(lead).delete(`/v1/teams/${team.id}/seats/${foreignSeat.id}`),
      404,
      'NOT_FOUND',
    );

    const row = await world.sql<
      { seat_count: number }[]
    >`SELECT seat_count FROM teams.team WHERE id = ${team.id}`;
    expect(row[0]?.seat_count).toBe(1);
    const events = await world.sql<{ type: string }[]>`
      SELECT type FROM teams.team_event WHERE team_id = ${team.id} AND type = 'seat_closed'`;
    expect(events).toHaveLength(1);
    const outbox = await world.sql<{ type: string }[]>`
      SELECT type FROM platform.outbox_event WHERE module = 'teams' AND type = 'seat_closed' AND aggregate_id = ${open.id}`;
    expect(outbox).toHaveLength(1);
  });

  it('FR-TEAM-01: updateTeam checks the version (409 VERSION_CONFLICT) and the lead', async () => {
    const lead = await person('patch');
    const team = await createTeam(lead);
    const url = `/v1/teams/${team.id}`;
    const ok = await world
      .as(lead)
      .patch(url, { version: team.version, name: 'Renamed', hoursPerWeek: 12 });
    expect(ok.statusCode, ok.body).toBe(200);
    expectMatchesContract('updateTeam', ok);
    expect(ok.json<TeamBody>()).toMatchObject({ name: 'Renamed', version: team.version + 1 });
    const stale = await world.as(lead).patch(url, { version: team.version, name: 'Again' });
    const problem = expectProblem('updateTeam', stale, 409, 'VERSION_CONFLICT');
    expect(problem.current).toMatchObject({ name: 'Renamed' });
    expectProblem(
      'updateTeam',
      await world.as(lead).patch(url, { version: team.version + 1, timezone: 'Mars/Base' }),
      422,
      'VALIDATION_FAILED',
    );
    const member = await person('patch-member');
    await world.sql`
      INSERT INTO teams.membership (id, team_id, user_id, status, joined_via, joined_at)
      VALUES (${randomUUID()}, ${team.id}, ${member.id}, 'active', 'offer', now())`;
    expectProblem(
      'updateTeam',
      await world.as(member).patch(url, { version: team.version + 1, name: 'Hijack' }),
      403,
      'NOT_TEAM_LEAD',
    );
    const completed = await createTeam(lead);
    await world.sql`UPDATE teams.team SET status = 'completed' WHERE id = ${completed.id}`;
    expectProblem(
      'updateTeam',
      await world
        .as(lead)
        .patch(`/v1/teams/${completed.id}`, { version: completed.version, name: 'Late' }),
      409,
      'INVALID_STATE',
    );
  });

  it('FR-TEAM-27: getTeam is a public card: any user reads it, the trial end only members', async () => {
    const lead = await person('card');
    const team = await createTeam(lead, { seats: [seatInput('qa')] });
    const member = await person('card-member');
    await world.sql`
      INSERT INTO teams.membership (id, team_id, user_id, status, joined_via, joined_at, trial_until)
      VALUES (${randomUUID()}, ${team.id}, ${member.id}, 'active', 'auto', now(), now() + interval '7 days')`;
    const stranger = await person('card-stranger');
    const asStranger = await world.as(stranger).get(`/v1/teams/${team.id}`);
    expect(asStranger.statusCode).toBe(200);
    expectMatchesContract('getTeam', asStranger);
    expect(asStranger.json<TeamBody>().members.every((m) => m.trialUntil === null)).toBe(true);
    const asMember = await world.as(lead).get(`/v1/teams/${team.id}`);
    expect(asMember.json<TeamBody>().members.some((m) => m.trialUntil !== null)).toBe(true);
    expectProblem(
      'getTeam',
      await world.as(stranger).get(`/v1/teams/${randomUUID()}`),
      404,
      'NOT_FOUND',
    );
  });

  it('FR-TEAM-26: listTeams shows teams with matching open seats, filters, and pages by cursor', async () => {
    const productType = 'ml_product';
    const names: string[] = [];
    for (const [index, role] of ['backend', 'frontend', 'qa'].entries()) {
      const lead = await person(`cat-${role}`);
      const team = await createTeam(lead, {
        name: `Catalog ${index}`,
        productTypeCode: productType,
        timezone: index === 0 ? 'Asia/Tokyo' : 'UTC',
        seats: [seatInput(role, { stack: index === 1 ? ['react'] : [] })],
      });
      names.push(team.id);
    }
    const empty = await createTeam(await person('cat-empty'), { productTypeCode: productType });
    const viewer = await person('cat-viewer');
    const get = async (query: string) => {
      const response = await world.as(viewer).get(`/v1/teams?productType=${productType}${query}`);
      expect(response.statusCode, response.body).toBe(200);
      expectMatchesContract('listTeams', response);
      return response.json<{
        items: { id: string; openSeats: { roleCode: string }[] }[];
        nextCursor: string | null;
      }>();
    };

    const all = await get('');
    expect(all.items.map((t) => t.id)).toEqual([...names].reverse());
    expect(all.items.map((t) => t.id)).not.toContain(empty.id);
    expect((await get('&role=frontend')).items.map((t) => t.id)).toEqual([names[1]]);
    expect((await get('&stack=react')).items.map((t) => t.id)).toEqual([names[1]]);
    expect((await get('&tzOffsetMin=480')).items.map((t) => t.id)).toEqual([names[0]]);
    expect((await get('&tzOffsetMax=60')).items.map((t) => t.id)).toEqual([names[2], names[1]]);

    const first = await get('&limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await get(`&limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((t) => t.id)).toEqual([names[0]]);
    expect(second.nextCursor).toBeNull();

    const foreignFilter = await world
      .as(viewer)
      .get(`/v1/teams?productType=web_service&cursor=${first.nextCursor}`);
    expectProblem('listTeams', foreignFilter, 400, 'VALIDATION_FAILED');
  });

  it('FR-TEAM-05: listMyTeams splits current and past teams and reports the lead flag', async () => {
    const user = await person('mine');
    const current = await createTeam(user, { name: 'Current' });
    const past = await createTeam(user, { name: 'Past' });
    await world.sql`UPDATE teams.team SET status = 'completed' WHERE id = ${past.id}`;
    const list = async (query: string) => {
      const response = await world.as(user).get(`/v1/me/teams${query}`);
      expect(response.statusCode, response.body).toBe(200);
      expectMatchesContract('listMyTeams', response);
      return response.json<{
        items: { team: { id: string }; isLead: boolean; membershipStatus: string }[];
        nextCursor: string | null;
      }>();
    };
    expect((await list('?status=current')).items.map((i) => i.team.id)).toEqual([current.id]);
    expect((await list('?status=past')).items.map((i) => i.team.id)).toEqual([past.id]);
    const everything = await list('');
    expect(everything.items.map((i) => i.team.id)).toEqual([past.id, current.id]);
    expect(everything.items.every((i) => i.isLead && i.membershipStatus === 'active')).toBe(true);
    const page = await list('?limit=1');
    expect(page.nextCursor).not.toBeNull();
    expect((await list(`?limit=1&cursor=${page.nextCursor}`)).items).toHaveLength(1);
  });

  it('FR-TEAM-21: listTeamEvents is members-only, newest first, with a cursor', async () => {
    const lead = await person('journal');
    const team = await createTeam(lead, { seats: [seatInput('backend'), seatInput('qa')] });
    const seat = team.seats[0] as SeatBody;
    await world
      .as(lead)
      .patch(`/v1/teams/${team.id}/seats/${seat.id}`, { version: seat.version, desired: true });
    const all = await world.as(lead).get(`/v1/teams/${team.id}/events`);
    expect(all.statusCode, all.body).toBe(200);
    expectMatchesContract('listTeamEvents', all);
    const items = all.json<{ items: { type: string; actorUserId: string }[] }>().items;
    expect(items.map((e) => e.type)).toEqual(
      expect.arrayContaining(['team_created', 'seat_opened', 'seat_desired_changed']),
    );
    expect(items[0]?.type).toBe('seat_desired_changed');
    expect(items.every((e) => e.actorUserId === lead.id)).toBe(true);

    const page = await world.as(lead).get(`/v1/teams/${team.id}/events?limit=2`);
    const cursor = page.json<{ nextCursor: string }>().nextCursor;
    const rest = await world.as(lead).get(`/v1/teams/${team.id}/events?limit=2&cursor=${cursor}`);
    const ids = [
      ...page.json<{ items: { id: string }[] }>().items,
      ...rest.json<{ items: { id: string }[] }>().items,
    ].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);

    const stranger = await person('journal-stranger');
    expectProblem(
      'listTeamEvents',
      await world.as(stranger).get(`/v1/teams/${team.id}/events`),
      404,
      'NOT_FOUND',
    );
  });
});
