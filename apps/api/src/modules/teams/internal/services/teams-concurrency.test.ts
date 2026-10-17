import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { githubIdentity } from '../../../../../test/fakes/github-server.js';
import { expectReplayed } from '../../../../../test/fixtures/assertions.js';
import type { UserFixture } from '../../../../../test/fixtures/index.js';
import { World } from '../../../../../test/fixtures/world.js';
import { codes, statuses } from '../../../../../test/helpers/http.js';
import { barrier, describeInfra } from '../../../../../test/helpers/infra.js';

const N = 20;

const teamInput = (extra: Record<string, unknown> = {}) => ({
  name: 'Race Team',
  description: 'd',
  timezone: 'UTC',
  hoursPerWeek: 10,
  productTypeCode: 'web_service',
  ...extra,
});

const seatInput = (roleCode: string) => ({
  roleCode,
  desired: false,
  minLevel: 'junior',
  minHours: 10,
  stack: [],
});

interface CreatedTeam {
  id: string;
  seats: { id: string; version: number }[];
}

describeInfra(
  'S3-03 CC-2: team creation and seat changes under concurrency',
  ['db', 'redis'],
  () => {
    let world: World;
    let deadlocksBefore = 0;

    beforeAll(async () => {
      world = await World.start({ worker: false });
      await world.ensureCatalog(['backend', 'qa']);
      deadlocksBefore = await world.deadlocks();
    });

    afterAll(async () => {
      if (!world) return;
      expect(await world.deadlocks()).toBe(deadlocksBefore);
      expect(world.logs.filter((line) => line.includes('40P01'))).toEqual([]);
      await world.close();
    });

    async function lead(): Promise<UserFixture> {
      const name = `race-${randomUUID().slice(0, 8)}`;
      return world.createUser(name, { github: githubIdentity(name) });
    }

    async function createTeamAs(user: UserFixture, seats = 0): Promise<CreatedTeam> {
      const seatList = Array.from({ length: seats }, () => seatInput('backend'));
      const body = teamInput(seats > 0 ? { seats: seatList } : {});
      const response = await world.as(user).post('/v1/teams', body);
      expect(response.statusCode, response.body).toBe(201);
      return response.json<CreatedTeam>();
    }

    const activeProjects = async (userId: string): Promise<number> => {
      const rows = await world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM teams.membership m JOIN teams.team t ON t.id = m.team_id
        WHERE m.user_id = ${userId} AND m.status = 'active'
          AND t.status IN ('forming','active','voting','suspended')`;
      return rows[0]?.n ?? Number.NaN;
    };

    it('CC-2 (v): 20 parallel createTeam by a user with no projects -> exactly 2 succeed, 18 x 409 PROJECT_LIMIT', async () => {
      const user = await lead();
      const gate = barrier(N);
      const results = await Promise.allSettled(
        Array.from({ length: N }, async () => {
          await gate.wait();
          return world.as(user).post('/v1/teams', teamInput());
        }),
      );
      expect(statuses(results)).toEqual({ 201: 2, 409: N - 2 });
      expect(codes(results, 409)).toEqual(Array(N - 2).fill('PROJECT_LIMIT'));
      expect(await activeProjects(user.id)).toBe(2);
      const teams = await world.sql<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM teams.team WHERE created_by = ${user.id}`;
      expect(teams[0]?.n).toBe(2);
    });

    it('CC-2 (v): with one project already, 20 parallel createTeam give exactly 1 success', async () => {
      const user = await lead();
      await createTeamAs(user);
      const gate = barrier(N);
      const results = await Promise.allSettled(
        Array.from({ length: N }, async () => {
          await gate.wait();
          return world.as(user).post('/v1/teams', teamInput());
        }),
      );
      expect(statuses(results)).toEqual({ 201: 1, 409: N - 1 });
      expect(await activeProjects(user.id)).toBe(2);
    });

    it('CC-2 (v): the same Idempotency-Key sent 20 times in parallel creates one team', async () => {
      const user = await lead();
      const key = randomUUID();
      const gate = barrier(N);
      const results = await Promise.allSettled(
        Array.from({ length: N }, async () => {
          await gate.wait();
          return world.as(user).post('/v1/teams', teamInput(), { idempotencyKey: key });
        }),
      );
      const ok = results.flatMap((r) =>
        r.status === 'fulfilled' && r.value.statusCode === 201 ? [r.value] : [],
      );
      expect(ok.length).toBeGreaterThanOrEqual(1);
      expect(new Set(ok.map((r) => r.json<{ id: string }>().id)).size).toBe(1);
      const repeat = await world.as(user).post('/v1/teams', teamInput(), { idempotencyKey: key });
      expect(repeat.statusCode).toBe(201);
      expectReplayed(repeat);
      expect(await activeProjects(user.id)).toBe(1);
    });

    it('FR-TEAM-02: 20 parallel addSeats of one seat on a team with 5 seats never exceed C-04 (12)', async () => {
      const user = await lead();
      const team = await createTeamAs(user, 5);
      const gate = barrier(N);
      const results = await Promise.allSettled(
        Array.from({ length: N }, async () => {
          await gate.wait();
          return world.as(user).post(`/v1/teams/${team.id}/seats`, { seats: [seatInput('qa')] });
        }),
      );
      expect(statuses(results)).toEqual({ 201: 7, 422: N - 7 });
      expect(codes(results, 422)).toEqual(Array(N - 7).fill('SEAT_LIMIT'));
      const rows = await world.sql<{ seats: number; counter: number }[]>`
        SELECT (SELECT count(*)::int FROM teams.seat WHERE team_id = ${team.id}) AS seats,
               (SELECT seat_count FROM teams.team WHERE id = ${team.id}) AS counter`;
      expect(rows[0]).toEqual({ seats: 12, counter: 12 });
      const ordinals = await world.sql<{ n: number }[]>`
        SELECT count(DISTINCT ordinal)::int AS n FROM teams.seat
        WHERE team_id = ${team.id} AND role_code = 'qa'`;
      expect(ordinals[0]?.n).toBe(7);
    });

    it('FR-TEAM-02: 20 parallel closeSeat of one open seat -> 1 x 204, 19 x 409 INVALID_STATE, counter drops once', async () => {
      const user = await lead();
      const team = await createTeamAs(user, 2);
      const seatId = team.seats[0]?.id ?? '';
      const gate = barrier(N);
      const results = await Promise.allSettled(
        Array.from({ length: N }, async () => {
          await gate.wait();
          return world.as(user).delete(`/v1/teams/${team.id}/seats/${seatId}`);
        }),
      );
      expect(statuses(results)).toEqual({ 204: 1, 409: N - 1 });
      expect(codes(results, 409)).toEqual(Array(N - 1).fill('INVALID_STATE'));
      const rows = await world.sql<
        { n: number }[]
      >`SELECT seat_count::int AS n FROM teams.team WHERE id = ${team.id}`;
      expect(rows[0]?.n).toBe(1);
    });

    it('FR-TEAM-03: 20 parallel updateSeat with one version -> 1 x 200, 19 x 409 VERSION_CONFLICT', async () => {
      const user = await lead();
      const team = await createTeamAs(user, 1);
      const seat = team.seats[0] as CreatedTeam['seats'][number];
      const gate = barrier(N);
      const results = await Promise.allSettled(
        Array.from({ length: N }, async (_, i) => {
          await gate.wait();
          return world.as(user).patch(`/v1/teams/${team.id}/seats/${seat.id}`, {
            version: seat.version,
            // never equal to the seat's own 10: an unchanged value is a no-op 200 that keeps the version
            minHours: 11 + i,
          });
        }),
      );
      expect(statuses(results)).toEqual({ 200: 1, 409: N - 1 });
      expect(codes(results, 409)).toEqual(Array(N - 1).fill('VERSION_CONFLICT'));
      const rows = await world.sql<
        { version: number }[]
      >`SELECT version FROM teams.seat WHERE id = ${seat.id}`;
      expect(rows[0]?.version).toBe(seat.version + 1);
    });
  },
);
