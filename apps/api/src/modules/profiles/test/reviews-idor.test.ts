import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import { send } from '../../../../test/fixtures/operations.js';
import {
  requestForRewards,
  REVIEW_OPERATIONS,
  type RewardsContext,
  type Slice7Operation,
} from '../../../../test/fixtures/operations-rewards.js';
import {
  createReview,
  receivedOk,
  reviewCountFor,
  reviewRows,
  sentReviews,
} from '../../../../test/fixtures/reviews.js';
import { membersOf, type Project } from '../../../../test/fixtures/rewards.js';
import { githubUser } from '../../../../test/fixtures/teams.js';
import { routeTeam, type RouteFixture } from '../../../../test/fixtures/workspace.js';
import { expectIdorResult, idorMatrix } from '../../../../test/helpers/authz.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { reviewProject, startReviewWorld, type ReviewWorld } from './reviews-support.js';

/*
 * S7-07 IDOR matrix of the review operations (docs/plan.md, "Тесты среза" -> IDOR; SEC-04, SEC-03), derived from
 * `x-authz` (test/helpers/authz.ts): createPeerReview and listSentReviews are `team-participant` with the chain
 * `teamId` (the rule: a row of `review_eligibility` for the team and the user; a foreign team is 404, never 403);
 * listReceivedReviews is `self` (the path is `/me/reviews`; nobody, the administrator included, reads another
 * user's reviews). Two completed projects (A, B), a team whose project is not completed (C), a stranger and an
 * administrator are the people of the matrix.
 */

describeInfra(
  'S7 profiles: review authorization matrix from x-authz (IDOR, SEC-04)',
  ['db', 'redis', 's3'],
  () => {
    let rw: ReviewWorld;
    let a: Project;
    let b: Project;
    let unfinished: RouteFixture;
    let stranger: UserFixture;

    beforeAll(async () => {
      rw = await startReviewWorld();
      // Building a project moves the shared clock by more than the window of C-27 (17 days): B is built
      // first, so that the window of A, which the tests write into, is still open.
      b = await reviewProject(rw);
      a = await reviewProject(rw);
      unfinished = await routeTeam(rw.world);
      stranger = await githubUser(rw.world, 'idor7r-stranger');
    }, 600_000);

    afterAll(async () => {
      if (rw) await rw.close();
    });

    const call = (
      who: UserFixture | undefined,
      operationId: Slice7Operation,
      context: RewardsContext,
    ) =>
      send(who ? rw.world.as(who) : rw.world.anonymous(), requestForRewards(operationId, context));

    const contextOf = (project: Project, subject: UserFixture): RewardsContext => ({
      teamId: project.fx.team.id,
      subjectUserId: subject.id,
    });

    describe('the matrix of x-authz', () => {
      it('SEC-04: the contract gives the review operations exactly the cases of this suite', () => {
        const kinds = (id: string): string[] =>
          idorMatrix(id)
            .cases.map((c) => c.kind)
            .sort();
        expect(kinds('createPeerReview')).toEqual(['anonymous', 'outsider']);
        expect(kinds('listSentReviews')).toEqual(['anonymous', 'outsider']);
        expect(kinds('listReceivedReviews')).toEqual(['admin', 'anonymous']);
      });
    });

    describe('(а) without a session -> 401', () => {
      it.each(REVIEW_OPERATIONS)('FR-AUTH-03: %s', async (operationId) => {
        const anonymous = idorMatrix(operationId).cases.find((c) => c.kind === 'anonymous');
        const response = await call(undefined, operationId, contextOf(a, a.backend));
        if (anonymous) expectIdorResult(anonymous, response);
        expectProblem(operationId, response, 401, 'UNAUTHENTICATED');
      });
    });

    describe('(б) a user outside the team gets 404, never 403, and nothing is written', () => {
      const outsiders = (): [string, UserFixture][] => [
        ['a stranger without any team', stranger],
        ['the administrator who is no participant', rw.admin],
        ['a member of another completed project', b.lead],
        ['a member of a team whose project is not completed', unfinished.backend],
      ];

      it.each(['createPeerReview', 'listSentReviews'] as const)(
        'SEC-04: %s by every kind of outsider -> 404 NOT_FOUND',
        async (operationId) => {
          const outsider = idorMatrix(operationId).cases.find((c) => c.kind === 'outsider');
          for (const [label, who] of outsiders()) {
            const response = await call(who, operationId, contextOf(a, a.backend));
            if (outsider) expectIdorResult(outsider, response);
            expectProblem(operationId, response, 404, 'NOT_FOUND');
            expect(response.body, label).not.toContain(a.lead.id);
          }
          expect(await reviewRows(rw.world, a.fx.team.id)).toEqual([]);
        },
      );

      it('SEC-04: the members of an unfinished project have no review window: 404 for the author and for the sent list', async () => {
        const team = { teamId: unfinished.team.id, subjectUserId: unfinished.frontend.id };
        expectProblem(
          'createPeerReview',
          await call(unfinished.backend, 'createPeerReview', team),
          404,
          'NOT_FOUND',
        );
        expectProblem(
          'listSentReviews',
          await call(unfinished.lead, 'listSentReviews', team),
          404,
          'NOT_FOUND',
        );
        expect(await reviewRows(rw.world, unfinished.team.id)).toEqual([]);
      });

      it('SEC-04: an unknown team -> 404, a malformed team id -> 400', async () => {
        const unknown = {
          teamId: '00000000-0000-4000-8000-000000000999',
          subjectUserId: a.backend.id,
        };
        expectProblem(
          'createPeerReview',
          await call(a.lead, 'createPeerReview', unknown),
          404,
          'NOT_FOUND',
        );
        expectProblem(
          'listSentReviews',
          await call(a.lead, 'listSentReviews', unknown),
          404,
          'NOT_FOUND',
        );
        const malformed = await rw.world.as(a.lead).get('/v1/teams/not-a-uuid/reviews/sent');
        expectProblem('listSentReviews', malformed, 400, 'VALIDATION_FAILED');
      });
    });

    describe('(в) the subject must be a participant of the same project', () => {
      it('SEC-04: a review about a participant of ANOTHER project, under the id of my own team -> 404, nothing written in either team', async () => {
        const response = await createReview(rw.world, a.lead, a.fx.team.id, b.backend.id);
        expectProblem('createPeerReview', response, 404, 'NOT_FOUND');
        expect(await reviewRows(rw.world, a.fx.team.id)).toEqual([]);
        expect(await reviewRows(rw.world, b.fx.team.id)).toEqual([]);
      });

      it('SEC-04: a review about a person who is in no team, or about an unknown user -> 404', async () => {
        expectProblem(
          'createPeerReview',
          await createReview(rw.world, a.lead, a.fx.team.id, stranger.id),
          404,
          'NOT_FOUND',
        );
        const unknown = '00000000-0000-4000-8000-000000000998';
        expectProblem(
          'createPeerReview',
          await createReview(rw.world, a.lead, a.fx.team.id, unknown),
          404,
          'NOT_FOUND',
        );
        expect(await reviewCountFor(rw.world, a.fx.team.id, stranger.id)).toBe(0);
      });

      it('SEC-04: the answer for a foreign subject and for an unknown one are the same (no oracle of membership)', async () => {
        const foreign = await createReview(rw.world, a.lead, a.fx.team.id, b.backend.id);
        const unknown = await createReview(
          rw.world,
          a.lead,
          a.fx.team.id,
          '00000000-0000-4000-8000-000000000997',
        );
        expect(foreign.statusCode).toBe(unknown.statusCode);
        expect(foreign.json<{ code: string }>().code).toBe(unknown.json<{ code: string }>().code);
      });
    });

    describe("(г) lists are the caller's own and nobody's else", () => {
      it('SEC-04: the sent list of project A shows only the reviews of the caller; a member of B asking for A gets 404', async () => {
        expect((await createReview(rw.world, a.lead, a.fx.team.id, a.backend.id)).statusCode).toBe(
          201,
        );
        expect(
          (await createReview(rw.world, a.frontend, a.fx.team.id, a.backend.id)).statusCode,
        ).toBe(201);
        const mine = await sentReviews(rw.world, a.frontend, a.fx.team.id);
        expect(mine.json<{ items: { subjectUserId: string }[] }>().items).toHaveLength(1);
        expect(mine.body).not.toContain(a.lead.id);
        expectProblem(
          'listSentReviews',
          await sentReviews(rw.world, b.lead, a.fx.team.id),
          404,
          'NOT_FOUND',
        );
      });

      it('SEC-04: the received list belongs to the caller: a stranger and the administrator get 200 with their own (empty) list', async () => {
        expect(await receivedOk(rw.world, stranger)).toEqual([]);
        expect(await receivedOk(rw.world, rw.admin)).toEqual([]);
        for (const member of membersOf(a)) expect(await receivedOk(rw.world, member)).toEqual([]);
      });

      it('SEC-04: there is no door to the reviews of another user: GET /v1/users/{id}/reviews is 404 for the administrator, the subject and others', async () => {
        for (const who of [rw.admin, a.backend, a.lead, stranger]) {
          const response = await rw.world.as(who).get(`/v1/users/${a.backend.id}/reviews`);
          expect(response.statusCode, `${who.displayName}: ${response.body}`).toBe(404);
          expect(response.body).not.toMatch(/Спасибо|отзыв по проекту/);
        }
      });

      it('SEC-04: the administrator is not a participant of the review window: his attempt to write for B is 404 and B is untouched', async () => {
        const response = await createReview(rw.world, rw.admin, b.fx.team.id, b.backend.id);
        expectProblem('createPeerReview', response, 404, 'NOT_FOUND');
        expect(await reviewRows(rw.world, b.fx.team.id)).toEqual([]);
      });
    });
  },
);
