import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import {
  activeApplications,
  applicationRow,
  membershipRow,
} from '../../../../test/fixtures/matching-db.js';
import {
  applicationBody,
  markAutoAdded,
  candidate,
  freshRole,
  searchApplication,
  type SearchApplicationFixture,
} from '../../../../test/fixtures/matching.js';
import { send } from '../../../../test/fixtures/operations.js';
import {
  requestForMatching,
  SLICE4_OPERATIONS,
  type MatchingContext,
} from '../../../../test/fixtures/operations-matching.js';
import { githubUser, team, type TeamFixture } from '../../../../test/fixtures/teams.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import type { World } from '../../../../test/fixtures/world.js';
import { expectIdorResult, idorMatrix } from '../../../../test/helpers/authz.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

describeInfra(
  'S4 matching: authorization matrix from x-authz (IDOR, SEC-03)',
  ['db', 'redis'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());
    /** Team A: a member marked as auto-added by SQL (the path to that state has its own suites). */
    let a: TeamFixture & {
      member: UserFixture;
      seat: TeamFixture['openSeats'][number];
      roleCode: string;
    };
    let b: TeamFixture;
    let stranger: UserFixture;
    let queued: SearchApplicationFixture;
    let regular: UserFixture;

    beforeAll(async () => {
      world = await startWorld({ clock });
      stranger = await githubUser(world, 'idor4-stranger');
      const roleCode = await freshRole(world);
      const built = await team(world, { members: 4, openSeats: 2, roleCode });
      const member = built.members[2] as UserFixture;
      await markAutoAdded(world, built.id, member.id);
      a = {
        ...built,
        member,
        seat: built.openSeats[0] as TeamFixture['openSeats'][number],
        roleCode,
      };
      regular = built.members[0] as UserFixture;
      b = await team(world, { members: 2, openSeats: 1 });
      queued = await searchApplication(world, {
        roles: [await freshRole(world)],
        label: 'idor4-queued',
      });
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    /** The team of the auto-added member; `seatId` is its second, still open seat. */
    const contextOf = (): MatchingContext => ({
      teamId: a.id,
      seatId: a.openSeats[1]?.id ?? a.seat.id,
      userId: a.member.id,
      roleCode: a.roleCode,
      version: queued.application.version,
    });

    describe('(а) without a session -> 401 for every operation', () => {
      it.each(SLICE4_OPERATIONS)('FR-AUTH-03: %s', async (operationId) => {
        const anonymous = idorMatrix(operationId).cases.find((c) => c.kind === 'anonymous');
        expect(anonymous, `${operationId} is public in the contract`).toBeDefined();
        const response = await send(
          world.anonymous(),
          requestForMatching(operationId, contextOf()),
        );
        if (anonymous) expectIdorResult(anonymous, response);
        expectProblem(operationId, response, 401, 'UNAUTHENTICATED');
      });
    });

    describe('(б) team-scoped operations: an outsider gets 404, never 403', () => {
      const SCOPED = SLICE4_OPERATIONS.filter((id) =>
        idorMatrix(id).cases.some((c) => c.kind === 'outsider'),
      );

      it('FR-MATCH-01, FR-TEAM-22: the matrix covers listSeatCandidates, excludeTrialMember and confirmTrial', () => {
        expect(SCOPED).toEqual(
          expect.arrayContaining(['listSeatCandidates', 'excludeTrialMember', 'confirmTrial']),
        );
      });

      it.each(SCOPED)('FR-MATCH-01: %s by a user outside the team', async (operationId) => {
        const outsider = idorMatrix(operationId).cases.find((c) => c.kind === 'outsider');
        const response = await send(
          world.as(stranger),
          requestForMatching(operationId, contextOf()),
        );
        if (outsider) expectIdorResult(outsider, response);
        expectProblem(operationId, response, 404, 'NOT_FOUND');
        expect((await membershipRow(world, a.id, a.member.id))?.status).toBe('active');
      });

      it('FR-MATCH-01: a foreign team and an unknown team look the same (no existence oracle)', async () => {
        const foreign = await world
          .as(stranger)
          .get(`/v1/teams/${a.id}/seats/${a.seat.id}/candidates`);
        const unknown = await world
          .as(stranger)
          .get(
            '/v1/teams/00000000-0000-4000-8000-000000000999/seats/00000000-0000-4000-8000-000000000998/candidates',
          );
        expect(foreign.statusCode).toBe(unknown.statusCode);
        const strip = (r: typeof foreign): Record<string, unknown> => {
          const body = r.json<Record<string, unknown>>();
          delete body['requestId'];
          delete body['instance'];
          return body;
        };
        expect(strip(foreign)).toEqual(strip(unknown));
      });
    });

    describe('(в) a nested id of another team gives 404 and changes nothing', () => {
      it('FR-MATCH-01: listSeatCandidates with a seat of team B under the id of team A -> 404', async () => {
        const seatB = b.openSeats[0];
        if (!seatB) throw new Error('no seat');
        const swapped = idorMatrix('listSeatCandidates').cases.filter(
          (c) => c.kind === 'swapped-id',
        );
        expect(swapped.length).toBeGreaterThan(0);
        const response = await send(
          world.as(a.lead),
          requestForMatching('listSeatCandidates', { teamId: a.id, seatId: seatB.id }),
        );
        for (const c of swapped) expectIdorResult(c, response);
        expectProblem('listSeatCandidates', response, 404, 'NOT_FOUND');
      });

      it('FR-MATCH-01: the lead of team B asking for a seat of team A under his own team id -> 404', async () => {
        expectProblem(
          'listSeatCandidates',
          await send(
            world.as(b.lead),
            requestForMatching('listSeatCandidates', { teamId: b.id, seatId: a.seat.id }),
          ),
          404,
          'NOT_FOUND',
        );
      });

      it('FR-MATCH-01: the lead of team B on team A with a seat of team A -> 404 (not his team)', async () => {
        expectProblem(
          'listSeatCandidates',
          await send(
            world.as(b.lead),
            requestForMatching('listSeatCandidates', { teamId: a.id, seatId: a.seat.id }),
          ),
          404,
          'NOT_FOUND',
        );
      });

      it.each(['excludeTrialMember', 'confirmTrial'] as const)(
        'FR-TEAM-22, FR-TEAM-24: %s with a userId that is not in the team (a member of team A under the id of team B) -> 404',
        async (operationId) => {
          const swapped = idorMatrix(operationId).cases.filter((c) => c.kind === 'swapped-id');
          expect(swapped.length).toBeGreaterThan(0);
          const response = await send(
            world.as(b.lead),
            requestForMatching(operationId, { teamId: b.id, userId: a.member.id }),
          );
          for (const c of swapped) expectIdorResult(c, response);
          expectProblem(operationId, response, 404, 'NOT_FOUND');
          const row = await membershipRow(world, a.id, a.member.id);
          expect(row).toMatchObject({ status: 'active' });
          expect(row?.trial_confirmed_at).toBeNull();
        },
      );

      it.each(['excludeTrialMember', 'confirmTrial'] as const)(
        'FR-TEAM-22, FR-TEAM-24: %s with an unknown userId -> 404',
        async (operationId) => {
          expectProblem(
            operationId,
            await send(world.as(a.lead), requestForMatching(operationId, { teamId: a.id })),
            404,
            'NOT_FOUND',
          );
        },
      );

      it.each(['excludeTrialMember', 'confirmTrial'] as const)(
        'FR-TEAM-22, FR-TEAM-24: %s with a userId that is not a UUID -> 400',
        async (operationId) => {
          const request = requestForMatching(operationId, { teamId: a.id });
          const response = await world
            .as(a.lead)
            .request(request.method, request.url.replace(/members\/[^/]+/, 'members/not-a-uuid'));
          expectProblem(operationId, response, 400, 'VALIDATION_FAILED');
        },
      );
    });

    describe('(г) a role below the lead gets 403 with a code', () => {
      const LEAD_OPS = SLICE4_OPERATIONS.filter((id) =>
        idorMatrix(id).cases.some((c) => c.kind === 'low-role'),
      );

      it('the lead operations of the slice are listSeatCandidates, excludeTrialMember, confirmTrial', () => {
        expect([...LEAD_OPS].sort()).toEqual(
          ['confirmTrial', 'excludeTrialMember', 'listSeatCandidates'].sort(),
        );
      });

      it.each(LEAD_OPS)(
        'FR-MATCH-01: %s by a member who is not the lead -> 403 NOT_TEAM_LEAD',
        async (operationId) => {
          const lowRole = idorMatrix(operationId).cases.find((c) => c.kind === 'low-role');
          const response = await send(
            world.as(regular),
            requestForMatching(operationId, contextOf()),
          );
          if (lowRole) expectIdorResult(lowRole, response);
          expectProblem(operationId, response, 403, 'NOT_TEAM_LEAD');
          expect((await membershipRow(world, a.id, a.member.id))?.status).toBe('active');
        },
      );

      it('FR-TEAM-22: the auto-added member himself cannot exclude or confirm himself -> 403', async () => {
        expect(
          (await world.as(a.member).delete(`/v1/teams/${a.id}/members/${a.member.id}`)).statusCode,
        ).toBe(403);
        expect(
          (
            await world
              .as(a.member)
              .post(`/v1/teams/${a.id}/members/${a.member.id}/trial-confirmation`)
          ).statusCode,
        ).toBe(403);
        const row = await membershipRow(world, a.id, a.member.id);
        expect(row).toMatchObject({ status: 'active' });
        expect(row?.trial_confirmed_at).toBeNull();
      });
    });

    describe('(д) self operations touch only the own application', () => {
      it('FR-MATCH-03, FR-MATCH-04: another person cannot read, change or cancel an application - he has none -> 404 each time, the application is intact', async () => {
        const intruder = await candidate(world, 'idor4-intruder', { roles: [] });
        const caller = world.as(intruder);
        expectProblem(
          'getMySearchApplication',
          await caller.get('/v1/me/search-application'),
          404,
          'APPLICATION_NOT_FOUND',
        );
        expectProblem(
          'updateSearchApplication',
          await caller.put('/v1/me/search-application', {
            roles: [{ roleCode: queued.roles[0], priority: 1 }],
            version: queued.application.version,
          }),
          404,
          'APPLICATION_NOT_FOUND',
        );
        expectProblem(
          'cancelSearchApplication',
          await caller.delete('/v1/me/search-application'),
          404,
          'APPLICATION_NOT_FOUND',
        );
        const row = await applicationRow(world, queued.application.id);
        expect(row).toMatchObject({ status: 'active', version: queued.application.version });
      });

      it("FR-MATCH-03: an owner id or an application id in the body is refused (400) - the application is always the caller's own", async () => {
        const person = await candidate(world, 'idor4-body-owner', {
          roles: [queued.roles[0] as string],
        });
        const caller = world.as(person);
        const withOwner = await caller.post('/v1/me/search-application', {
          ...applicationBody([queued.roles[0] as string]),
          userId: queued.user.id,
        });
        expectProblem('createSearchApplication', withOwner, 400, 'VALIDATION_FAILED');
        expect(await activeApplications(world, queued.user.id)).toBe(1);
        expect(await activeApplications(world, person.id)).toBe(0);
        expectProblem(
          'updateSearchApplication',
          await world.as(queued.user).put('/v1/me/search-application', {
            roles: [{ roleCode: queued.roles[0], priority: 1 }],
            version: queued.application.version,
            id: queued.application.id,
          }),
          400,
          'VALIDATION_FAILED',
        );
      });

      it('FR-MATCH-03: the demand and the recommendations are per caller: the recommendations of one person never contain the application of another', async () => {
        const response = await world.as(stranger).get('/v1/me/recommended-teams');
        expect(response.statusCode, response.body).toBe(200);
        expect(response.body).not.toContain(queued.user.id);
        expect(response.body).not.toContain(queued.application.id);
      });
    });
  },
);

describe('S4 matching: IDOR matrix helper', () => {
  it('derives the lead cases for the three team-lead operations of the slice', () => {
    for (const id of ['listSeatCandidates', 'excludeTrialMember', 'confirmTrial'] as const) {
      expect(idorMatrix(id).cases.map((c) => c.kind)).toEqual(
        expect.arrayContaining(['anonymous', 'outsider', 'swapped-id', 'low-role']),
      );
    }
  });
});
