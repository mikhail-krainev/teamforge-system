import { afterAll, beforeAll, expect, it } from 'vitest';
import { expectProblem } from '../../../../../test/fixtures/assertions.js';
import {
  candidate,
  freshRole,
  teamWithDemand,
  type CandidateRecommendationDto,
  type Page,
} from '../../../../../test/fixtures/matching.js';
import { expectOk, githubUser, team } from '../../../../../test/fixtures/teams.js';
import { World } from '../../../../../test/fixtures/world.js';
import { describeInfra, waitFor } from '../../../../../test/helpers/infra.js';

const NOWHERE = '00000000-0000-4000-8000-000000000999';

describeInfra(
  'S4-04 listSeatCandidates: access chain team -> seat (SEC-03, FR-MATCH-01)',
  ['db', 'redis'],
  () => {
    let world: World;

    beforeAll(async () => {
      world = await World.start({ worker: false });
      await world.ensureCatalog(['backend', 'frontend', 'pm', 'designer', 'qa', 'devops']);
    });

    afterAll(async () => {
      await world?.close();
    });

    it('a seat of another team under my team id -> 404 NOT_FOUND', async () => {
      const mine = await team(world, { members: 2, openSeats: 1 });
      const other = await team(world, { members: 2, openSeats: 1 });
      const response = await world
        .as(mine.lead)
        .get(`/v1/teams/${mine.id}/seats/${other.openSeats[0]?.id}/candidates`);
      expectProblem('listSeatCandidates', response, 404, 'NOT_FOUND');
    });

    it('an unknown seat of my team -> 404 NOT_FOUND', async () => {
      const mine = await team(world, { members: 2, openSeats: 1 });
      const response = await world
        .as(mine.lead)
        .get(`/v1/teams/${mine.id}/seats/${NOWHERE}/candidates`);
      expectProblem('listSeatCandidates', response, 404, 'NOT_FOUND');
    });

    it('a member who is not the lead -> 403 NOT_TEAM_LEAD, a stranger -> 404, no session -> 401', async () => {
      const mine = await team(world, { members: 2, openSeats: 1 });
      const url = `/v1/teams/${mine.id}/seats/${mine.openSeats[0]?.id}/candidates`;
      const member = mine.members[0];
      if (!member) throw new Error('no member');
      expectProblem('listSeatCandidates', await world.as(member).get(url), 403, 'NOT_TEAM_LEAD');
      const stranger = await githubUser(world, 'rec-access-stranger');
      expectProblem('listSeatCandidates', await world.as(stranger).get(url), 404, 'NOT_FOUND');
      expectProblem('listSeatCandidates', await world.anonymous().get(url), 401, 'UNAUTHENTICATED');
    });

    it('a cursor made for another seat is refused (400), not applied', async () => {
      const role = await freshRole(world);
      await candidate(world, 'rec-access-cursor', { roles: [role] });
      const a = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
      const b = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
      const url = (t: typeof a): string =>
        `/v1/teams/${t.id}/seats/${t.openSeats[0]?.id}/candidates`;
      const forged = Buffer.from(
        JSON.stringify({ v: 1, k: ['0.900', NOWHERE], f: 'deadbeefdeadbeef' }),
        'utf8',
      ).toString('base64url');
      expectProblem(
        'listSeatCandidates',
        await world.as(a.lead).get(`${url(a)}?cursor=${forged}`),
        400,
        'VALIDATION_FAILED',
      );
      expectProblem(
        'listSeatCandidates',
        await world.as(b.lead).get(`${url(b)}?cursor=${forged}`),
        400,
        'VALIDATION_FAILED',
      );
    });
  },
);

describeInfra(
  'S4-04 recompute: completed projects (C-44e) and the daily full recompute',
  ['db', 'redis'],
  () => {
    let world: World;

    beforeAll(async () => {
      world = await World.start();
      await world.ensureCatalog(['backend', 'frontend', 'pm', 'designer', 'qa', 'devops']);
    });

    afterAll(async () => {
      await world?.close();
    });

    it('candidate_stats raises the score by 0.1 for 3 completed projects in the role', async () => {
      const role = await freshRole(world);
      const veteran = await candidate(world, 'rec-veteran', { roles: [role] });
      const newcomer = await candidate(world, 'rec-newcomer', { roles: [role] });
      await world.sql`
        INSERT INTO matching.candidate_stats (user_id, role_code, completed_count)
        VALUES (${veteran.id}, ${role}, 5)`;
      const f = await teamWithDemand(world, { roleCode: role, openSeats: 1 });
      const url = `/v1/teams/${f.id}/seats/${f.openSeats[0]?.id}/candidates?limit=100`;
      const items = await waitFor(
        async () => {
          const page = expectOk<Page<CandidateRecommendationDto>>(
            'listSeatCandidates',
            await world.as(f.lead).get(url),
            200,
          );
          return page.items.length >= 2 ? page.items : false;
        },
        30_000,
        250,
      );
      const byId = new Map(items.map((i) => [i.userId, i]));
      expect(byId.get(veteran.id)?.reasons.completedProjects).toBe(1);
      expect(byId.get(newcomer.id)?.reasons.completedProjects).toBe(0);
      expect((byId.get(veteran.id)?.score ?? 0) - (byId.get(newcomer.id)?.score ?? 0)).toBeCloseTo(
        0.1,
        3,
      );
      expect(items[0]?.userId).toBe(veteran.id);
    });
  },
);
