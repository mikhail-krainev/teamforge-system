import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import { send } from '../../../../test/fixtures/operations.js';
import {
  FRAUD_OPERATIONS,
  REWARD_OPERATIONS,
  requestForRewards,
  type RewardsContext,
  type Slice7Operation,
} from '../../../../test/fixtures/operations-rewards.js';
import {
  awardsOk,
  completedProject,
  countersOk,
  creditOk,
  dispute,
  DISPUTE_TEXT,
  joinLate,
  leaveEarly,
  openCaseOf,
  type Project,
} from '../../../../test/fixtures/rewards.js';
import {
  auditRows,
  creditRunRow,
  disputeCount,
  fraudCaseRows,
} from '../../../../test/fixtures/rewards-db.js';
import { githubUser } from '../../../../test/fixtures/teams.js';
import { expectIdorResult, idorMatrix } from '../../../../test/helpers/authz.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { expectNoFraudDetails, startRewardsWorld, type RewardsWorld } from './support.js';

/*
 * S7-05, S7-06 IDOR matrix of the rewards and admin operations (docs/plan.md, "Тесты среза" -> IDOR; SEC-03,
 * FR-AUTH-08, FR-REW-15, FR-REW-16), derived from `x-authz` (test/helpers/authz.ts) and realised with two projects:
 * A is frozen by AF-05 (it has an open fraud case), B is clean and has a member who left before the completion.
 *   - getTeamCredit, createDispute: `team-participant` (chain teamId) -> a foreign team is 404, never 403;
 *   - listFraudCases, getFraudCase, decideFraudCase: `admin` -> an ordinary user is 403 ADMIN_ONLY, also for a
 *     participant of the project and also for an unknown case (no oracle);
 *   - listBadges, listUserAwards, getUserCounters: `authenticated`; their answers carry nothing of the anti-fraud.
 * The review operations of the slice are in profiles/test/reviews-idor.test.ts.
 */

const ADMIN_OPERATIONS = FRAUD_OPERATIONS;
const SCOPED = ['getTeamCredit', 'createDispute'] as const;

describeInfra(
  'S7 rewards: authorization matrix from x-authz (IDOR, FR-AUTH-08, FR-REW-15)',
  ['db', 'redis', 's3'],
  () => {
    let rw: RewardsWorld;
    let a: Project;
    let b: Project;
    let ghost: UserFixture;
    let stranger: UserFixture;
    let caseId: string;

    beforeAll(async () => {
      rw = await startRewardsWorld();
      stranger = await githubUser(rw.world, 'idor7-stranger');
      a = await completedProject(rw.world, { prLines: 20 });
      caseId = (await openCaseOf(rw.world, rw.admin, a.fx.team.id)).id;
      let left: UserFixture | undefined;
      b = await completedProject(rw.world, {
        beforeCompletion: async (project) => {
          left = await joinLate(project, 'devops');
          await leaveEarly(project, left);
        },
      });
      if (!left) throw new Error('the member who left was not created');
      ghost = left;
    }, 600_000);

    afterAll(async () => {
      if (rw) await rw.close();
    });

    const contextOf = (): RewardsContext => ({
      teamId: a.fx.team.id,
      userId: a.backend.id,
      caseId,
    });

    const call = (
      who: UserFixture | undefined,
      operationId: Slice7Operation,
      context: RewardsContext = contextOf(),
    ) =>
      send(who ? rw.world.as(who) : rw.world.anonymous(), requestForRewards(operationId, context));

    describe('the matrix of x-authz', () => {
      it('SEC-03: the scoped operations have the cases anonymous and outsider, the admin ones only anonymous (the rest is FR-AUTH-08)', () => {
        const kinds = (id: string): string[] =>
          idorMatrix(id)
            .cases.map((c) => c.kind)
            .sort();
        for (const id of SCOPED) expect(kinds(id), id).toEqual(['anonymous', 'outsider']);
        for (const id of ADMIN_OPERATIONS) expect(kinds(id), id).toEqual(['anonymous']);
        for (const id of ['listBadges', 'listUserAwards', 'getUserCounters'])
          expect(kinds(id), id).toEqual(['anonymous']);
      });
    });

    describe('(а) without a session -> 401 for every operation', () => {
      it.each([...REWARD_OPERATIONS, ...ADMIN_OPERATIONS])(
        'FR-AUTH-03: %s',
        async (operationId) => {
          const anonymous = idorMatrix(operationId).cases.find((c) => c.kind === 'anonymous');
          const response = await call(undefined, operationId);
          if (anonymous) expectIdorResult(anonymous, response);
          expectProblem(operationId, response, 401, 'UNAUTHENTICATED');
        },
      );
    });

    describe('(б) a user outside the team gets 404, never 403, and nothing is written', () => {
      const outsiders = (): [string, UserFixture][] => [
        ['a stranger without any team', stranger],
        ['the administrator who is no participant', rw.admin],
        ['a member of another project', b.lead],
        ['a member who left before the completion', ghost],
      ];

      it.each(SCOPED)(
        'SEC-03: %s by every kind of outsider -> 404 NOT_FOUND',
        async (operationId) => {
          const outsider = idorMatrix(operationId).cases.find((c) => c.kind === 'outsider');
          for (const [label, who] of outsiders()) {
            const response = await call(who, operationId);
            if (outsider) expectIdorResult(outsider, response);
            expectProblem(operationId, response, 404, 'NOT_FOUND');
            expect(response.body, label).not.toContain(a.backend.id);
          }
          expect(await disputeCount(rw.world, a.fx.team.id)).toBe(0);
          expect((await creditRunRow(rw.world, a.fx.team.id))?.status).toBe('frozen');
        },
      );

      it('SEC-03: a dispute by an outsider does not join the open case and leaves no text behind', async () => {
        const response = await dispute(rw.world, stranger, a.fx.team.id, DISPUTE_TEXT);
        expectProblem('createDispute', response, 404, 'NOT_FOUND');
        expect(await fraudCaseRows(rw.world, a.fx.team.id)).toEqual([
          expect.objectContaining({ id: caseId }),
        ]);
      });

      it('SEC-03: a foreign team and an unknown one look the same to the outsider (no oracle of existence)', async () => {
        const foreign = await call(stranger, 'getTeamCredit');
        const unknown = await call(stranger, 'getTeamCredit', {
          teamId: '00000000-0000-4000-8000-000000000996',
        });
        expect(foreign.statusCode).toBe(unknown.statusCode);
        expect(foreign.json<{ code: string }>().code).toBe(unknown.json<{ code: string }>().code);
      });

      it('SEC-03: a malformed team id -> 400 VALIDATION_FAILED', async () => {
        const response = await rw.world.as(a.lead).get('/v1/teams/not-a-uuid/credit');
        expectProblem('getTeamCredit', response, 400, 'VALIDATION_FAILED');
      });
    });

    describe('(в) the administrator operations: an ordinary user gets 403 ADMIN_ONLY', () => {
      const ordinary = (): [string, UserFixture][] => [
        ['a participant of the frozen project', a.backend],
        ['the lead of the frozen project', a.lead],
        ['a stranger', stranger],
      ];

      it.each(ADMIN_OPERATIONS)(
        'FR-AUTH-08: %s by a participant, the lead and a stranger',
        async (operationId) => {
          for (const [label, who] of ordinary()) {
            const response = await call(who, operationId);
            expectProblem(operationId, response, 403, 'ADMIN_ONLY');
            expect(response.body, label).not.toMatch(/AF-\d{2}/);
          }
        },
      );

      it('FR-AUTH-08: the refusal is the same for a known case and for an unknown one: the case id is no oracle', async () => {
        const known = await call(stranger, 'getFraudCase');
        const unknown = await call(stranger, 'getFraudCase', {
          caseId: '00000000-0000-4000-8000-000000000995',
        });
        expect(known.statusCode).toBe(403);
        expect(unknown.statusCode).toBe(403);
        expect(known.json<{ code: string }>().code).toBe(unknown.json<{ code: string }>().code);
      });

      it('FR-AUTH-08, AF-25: refused decisions change nothing: the case is open, the project frozen, no audit row', async () => {
        await call(a.backend, 'decideFraudCase');
        await call(stranger, 'decideFraudCase');
        expect(await fraudCaseRows(rw.world, a.fx.team.id)).toEqual([
          expect.objectContaining({ status: 'open', decided_by: null }),
        ]);
        expect((await creditRunRow(rw.world, a.fx.team.id))?.status).toBe('frozen');
        expect(await auditRows(rw.world, caseId)).toEqual([]);
      });

      it('FR-REW-16: for the administrator an unknown case is 404 and a malformed id 400', async () => {
        const unknown = await call(rw.admin, 'getFraudCase', {
          caseId: '00000000-0000-4000-8000-000000000994',
        });
        expectProblem('getFraudCase', unknown, 404, 'NOT_FOUND');
        const malformed = await rw.world.as(rw.admin).get('/v1/admin/fraud-cases/not-a-uuid');
        expectProblem('getFraudCase', malformed, 400, 'VALIDATION_FAILED');
        const decision = await rw.world
          .as(rw.admin)
          .post('/v1/admin/fraud-cases/not-a-uuid/decision', {
            decision: 'ok',
            comment: 'Проверено вручную, замечаний нет.',
          });
        expectProblem('decideFraudCase', decision, 400, 'VALIDATION_FAILED');
      });
    });

    describe('(г) what a participant and what everybody may read (FR-REW-15, FR-PROF-06)', () => {
      it("FR-REW-15: a participant of the frozen project reads his credit and no other person's credits, rules or disputes", async () => {
        expect(
          (
            await dispute(
              rw.world,
              a.frontend,
              a.fx.team.id,
              `${DISPUTE_TEXT} Это текст жалобы участника.`,
            )
          ).statusCode,
        ).toBe(201);
        const response = await rw.world.as(a.backend).get(`/v1/teams/${a.fx.team.id}/credit`);
        expect(response.statusCode).toBe(200);
        expectNoFraudDetails(response);
        expect(response.body).not.toContain('Это текст жалобы участника');
        expect(response.body).not.toContain(a.frontend.id);
        expect((await creditOk(rw.world, a.backend, a.fx.team.id)).status).toBe('frozen');
      });

      it('FR-REW-15, FR-PROF-06: the awards and the counters of a person in a frozen project are public and carry no sign of it', async () => {
        for (const who of [stranger, b.lead, rw.admin]) {
          const awards = await rw.world.as(who).get(`/v1/users/${a.backend.id}/awards`);
          const counters = await rw.world.as(who).get(`/v1/users/${a.backend.id}/counters`);
          expect(awards.statusCode).toBe(200);
          expect(counters.statusCode).toBe(200);
          expectNoFraudDetails(awards);
          expectNoFraudDetails(counters);
          expect(awards.body + counters.body).not.toContain(a.fx.team.id);
        }
        expect((await countersOk(rw.world, stranger, a.backend.id)).total).toBe(0);
        expect(await awardsOk(rw.world, stranger, a.backend.id)).toEqual([]);
      });

      it('FR-REW-15: the list of cases is for the administrator only and shows the dispute of A once the participant has filed it', async () => {
        const page = (await call(rw.admin, 'listFraudCases')).json<{
          items: { teamId: string; disputes?: unknown[] }[];
        }>();
        const mine = page.items.find((c) => c.teamId === a.fx.team.id);
        expect(mine?.disputes?.length ?? 0).toBeGreaterThanOrEqual(1);
      });
    });
  },
);
