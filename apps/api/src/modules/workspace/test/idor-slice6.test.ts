import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import { feedOk, linkedTeam } from '../../../../test/fixtures/completion.js';
import { closedIssueDelivered, ghPerson } from '../../../../test/fixtures/github.js';
import { contributionRows, completionCount } from '../../../../test/fixtures/github-db.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import { send } from '../../../../test/fixtures/operations.js';
import {
  FEED_OPERATIONS,
  requestForGithub,
  type GithubContext,
  type Slice6Operation,
} from '../../../../test/fixtures/operations-github.js';
import { githubUser } from '../../../../test/fixtures/teams.js';
import { startRouteWorld, type RouteFixture } from '../../../../test/fixtures/workspace.js';
import type { World } from '../../../../test/fixtures/world.js';
import { expectIdorResult, idorMatrix } from '../../../../test/helpers/authz.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

/*
 * S6-02 IDOR matrix of the workspace operations of slice 6 (docs/plan.md, "Тесты среза" -> IDOR; SEC-03):
 * getTeamFeed, getContributionSummary, relabelContribution, requestCompletionCheck,
 * getLatestCompletionCheck, completeProject, getCompletion. Derived from x-authz (test/helpers/authz.ts),
 * realised with two teams that have a repository and a contribution each.
 */

describeInfra(
  'S6 workspace: authorization matrix from x-authz (IDOR, SEC-03)',
  ['db', 'redis'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());
    let a: RouteFixture;
    let b: RouteFixture;
    let contributionA: string;
    let contributionB: string;
    let stranger: UserFixture;

    beforeAll(async () => {
      world = await startRouteWorld({ github: true, clock });
      const builtA = await linkedTeam(world);
      const builtB = await linkedTeam(world);
      a = builtA.fx;
      b = builtB.fx;
      stranger = await githubUser(world, 'idor6w-stranger');
      for (const [built, fx] of [
        [builtA, a],
        [builtB, b],
      ] as const) {
        const person = await ghPerson(world, fx.backend);
        await closedIssueDelivered(world, built.connected.repo, {
          author: person,
          assignees: [person],
        });
      }
      contributionA = (await feedOk(world, a.lead, a.team.id)).items[0]?.id ?? '';
      contributionB = (await feedOk(world, b.lead, b.team.id)).items[0]?.id ?? '';
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    const contextOf = (): GithubContext => ({
      teamId: a.team.id,
      contributionId: contributionA,
      roleCode: 'backend',
    });

    const call = (
      who: UserFixture | undefined,
      operationId: Slice6Operation,
      context: GithubContext,
    ) => {
      const request = requestForGithub(operationId, context);
      return send(who ? world.as(who) : world.anonymous(), request);
    };

    it('SEC-03: the fixtures produced contributions with distinct ids in both teams', () => {
      expect(contributionA).not.toBe('');
      expect(contributionB).not.toBe('');
      expect(contributionA).not.toBe(contributionB);
    });

    describe('(а) without a session -> 401 for every operation', () => {
      it.each(FEED_OPERATIONS)('FR-AUTH-03: %s', async (operationId) => {
        const anonymous = idorMatrix(operationId).cases.find((c) => c.kind === 'anonymous');
        const response = await call(undefined, operationId, contextOf());
        if (anonymous) expectIdorResult(anonymous, response);
        expectProblem(operationId, response, 401, 'UNAUTHENTICATED');
      });
    });

    describe('(б) an outsider and the lead of another team get 404, never 403', () => {
      it('SEC-03: the matrix covers all seven operations', () => {
        const scoped = FEED_OPERATIONS.filter((id) =>
          idorMatrix(id).cases.some((c) => c.kind === 'outsider'),
        );
        expect([...scoped].sort()).toEqual([...FEED_OPERATIONS].sort());
      });

      it.each(FEED_OPERATIONS)('SEC-03: %s by a user outside the team', async (operationId) => {
        const outsider = idorMatrix(operationId).cases.find((c) => c.kind === 'outsider');
        const response = await call(stranger, operationId, contextOf());
        if (outsider) expectIdorResult(outsider, response);
        expectProblem(operationId, response, 404, 'NOT_FOUND');
      });

      it.each(FEED_OPERATIONS)('SEC-03: %s by the lead of another team', async (operationId) => {
        const response = await call(b.lead, operationId, contextOf());
        expectProblem(operationId, response, 404, 'NOT_FOUND');
      });

      it('SEC-03: nothing of team A changed after all these calls', async () => {
        expect(await completionCount(world, a.team.id)).toBe(0);
        const [row] = (await contributionRows(world, a.team.id)).filter(
          (r) => r.id === contributionA,
        );
        expect(row?.role_code).toBe('backend');
      });
    });

    describe('(в) team-lead operations: a member gets 403 with a code', () => {
      const LEAD_ONLY = FEED_OPERATIONS.filter((id) =>
        idorMatrix(id).cases.some((c) => c.kind === 'low-role'),
      );

      it('SEC-03: requestCompletionCheck and completeProject are for the lead', () => {
        expect([...LEAD_ONLY].sort()).toEqual(['completeProject', 'requestCompletionCheck']);
      });

      it.each(LEAD_ONLY)('SEC-03: %s by a member who is not the lead', async (operationId) => {
        const lowRole = idorMatrix(operationId).cases.find((c) => c.kind === 'low-role');
        const response = await call(a.backend, operationId, contextOf());
        if (lowRole) expectIdorResult(lowRole, response);
        expectProblem(operationId, response, 403, 'NOT_TEAM_LEAD');
        expect(await completionCount(world, a.team.id)).toBe(0);
      });
    });

    describe('(г) a nested id of another team gives 404 and changes nothing', () => {
      it('SEC-03: relabelContribution with the contribution of team B under the id of team A -> 404; the label of B stays', async () => {
        const response = await call(a.backend, 'relabelContribution', {
          ...contextOf(),
          contributionId: contributionB,
        });
        expectProblem('relabelContribution', response, 404, 'NOT_FOUND');
        const [row] = (await contributionRows(world, b.team.id)).filter(
          (r) => r.id === contributionB,
        );
        expect(row?.role_code).toBe('backend');
      });

      it('SEC-03: relabelContribution with the contribution of A under the id of B by the member of B -> 404', async () => {
        const response = await call(b.backend, 'relabelContribution', {
          teamId: b.team.id,
          contributionId: contributionA,
          roleCode: 'backend',
        });
        expectProblem('relabelContribution', response, 404, 'NOT_FOUND');
      });

      it('SEC-03: the feed of team A never contains an entry of team B, whatever the filter', async () => {
        const mineIds = new Set(
          (await feedOk(world, a.lead, a.team.id, { limit: 100 })).items.map((e) => e.id),
        );
        expect(mineIds.has(contributionB)).toBe(false);
        const filtered = await feedOk(world, a.lead, a.team.id, { userId: b.backend.id });
        expect(filtered.items).toEqual([]);
      });

      it('SEC-03: the contribution of a colleague is 404 for a member (rule: user_id = the current user)', async () => {
        const response = await call(a.frontend, 'relabelContribution', {
          ...contextOf(),
          roleCode: 'frontend',
        });
        expectProblem('relabelContribution', response, 404, 'NOT_FOUND');
      });
    });
  },
);
