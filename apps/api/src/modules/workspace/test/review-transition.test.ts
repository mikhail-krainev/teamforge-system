import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pdfFile } from '../../../../test/fixtures/artifact-files.js';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import { DAY, expectOk, githubUser } from '../../../../test/fixtures/teams.js';
import {
  acceptRisk,
  advanceStage,
  assign,
  checklistOf,
  waitMinimumStageTime,
  clockOf,
  completeStageOne,
  completeStageTwo,
  doneRitual,
  doneWithFile,
  doneWithLink,
  itemOf,
  passReview,
  patchItem,
  routeTeam,
  stagesOf,
  submitReview,
  transition,
  uploadFile,
  type ChecklistItemDto,
  type RouteFixture,
  type UnmetDto,
} from '../../../../test/fixtures/workspace.js';
import {
  itemRows,
  openStageCount,
  participationCount,
  reviewAnswerCount,
  riskCount,
  stageRows,
} from '../../../../test/fixtures/workspace-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

/*
 * S5-01 for S5-07 and S5-08: the review checklist, risk acceptance, the stage transition (FR-WORK-09,
 * -10, -11, CC-5) and the confirmation of participation. The conditions of the transition and their
 * UnmetCode values are those of docs/architecture.md 11.3 and the contract; the contract answers
 * 409 STAGE_TRANSITION_BLOCKED with unmet[] (the plan says "422 с unmet[]": see the report).
 */

describeInfra(
  'S5 workspace: review, transition and participation (FR-WORK-09..11)',
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

    const unmetOf = async (t: RouteFixture, from: number): Promise<UnmetDto[]> => {
      const response = await transition(world, t.lead, t.team.id, from);
      const problem = expectProblem('transitionStage', response, 409, 'STAGE_TRANSITION_BLOCKED');
      return (problem as unknown as { unmet: UnmetDto[] }).unmet;
    };
    const codesOf = (unmet: UnmetDto[]): string[] => unmet.map((u) => u.code).sort();

    /** A spec item with its file, done; the reviewer is the frontend member (never the author). */
    const specDone = async (t: RouteFixture): Promise<ChecklistItemDto> =>
      doneWithFile(t, 'mini_spec', t.backend);

    describe('a review belongs to the artifact it judged (FR-WORK-09)', () => {
      const reviewedSpec = async (t: RouteFixture): Promise<ChecklistItemDto> => {
        const done = await specDone(t);
        const answered = expectOk<ChecklistItemDto>(
          'submitReview',
          await submitReview(world, t.frontend, t.team.id, done, [
            { ordinal: 1, answer: true },
            { ordinal: 2, answer: false },
            { ordinal: 3, answer: true },
          ]),
          200,
        );
        expectOk('acceptReviewRisk', await acceptRisk(world, t.lead, t.team.id, answered, 2), 200);
        const item = await itemOf(t, 'mini_spec');
        expect(await reviewAnswerCount(world, item.id)).toBe(3);
        expect(await riskCount(world, item.id)).toBe(1);
        return item;
      };

      it('replacing the link drops the answers and the accepted risks', async () => {
        const t = await routeTeam(world);
        const item = await reviewedSpec(t);
        expectOk(
          'updateChecklistItem',
          await patchItem(world, t.backend, t.team.id, item.id, {
            version: item.version,
            linkUrl: 'https://example.test/new-spec',
          }),
          200,
        );
        expect(await reviewAnswerCount(world, item.id)).toBe(0);
        expect(await riskCount(world, item.id)).toBe(0);
      });

      it('returning the item to open drops the answers and the accepted risks', async () => {
        const t = await routeTeam(world);
        const item = await reviewedSpec(t);
        expectOk(
          'updateChecklistItem',
          await patchItem(world, t.backend, t.team.id, item.id, {
            version: item.version,
            status: 'open',
          }),
          200,
        );
        expect(await reviewAnswerCount(world, item.id)).toBe(0);
        expect(await riskCount(world, item.id)).toBe(0);
      });

      it('files cannot be added or removed while the item is done, so a review never judges a replaced file: only reopening (which drops the review) allows it', async () => {
        const t = await routeTeam(world);
        const item = await reviewedSpec(t);
        const files = (await itemOf(t, 'mini_spec')).files;
        const fileId = files[0]?.id;
        if (fileId === undefined) throw new Error('the spec item has no file');
        expectProblem(
          'uploadArtifactFile',
          await uploadFile(world, t.backend, t.team.id, item.id),
          409,
          'INVALID_STATE',
        );
        expectProblem(
          'deleteArtifactFile',
          await world
            .as(t.backend)
            .delete(`/v1/teams/${t.team.id}/checklist-items/${item.id}/files/${fileId}`),
          409,
          'INVALID_STATE',
        );
        expect(await reviewAnswerCount(world, item.id)).toBe(3);
        expect(await riskCount(world, item.id)).toBe(1);
      });

      it('a write that changes neither the link nor the status keeps the review', async () => {
        const t = await routeTeam(world);
        const item = await reviewedSpec(t);
        expectOk(
          'updateChecklistItem',
          await patchItem(world, t.backend, t.team.id, item.id, {
            version: item.version,
            roleCode: 'backend',
          }),
          200,
        );
        expect(await reviewAnswerCount(world, item.id)).toBe(3);
      });
    });

    describe('submitReview (FR-WORK-09)', () => {
      it('FR-WORK-09: a member who is not the author answers every point "yes" -> 200, the review is passed, the points are listed with their text', async () => {
        const t = await routeTeam(world);
        await specDone(t);
        const reviewed = await passReview(t, 'mini_spec', t.frontend);
        expect(reviewed.review).toMatchObject({ reviewerUserId: t.frontend.id, passed: true });
        expect(reviewed.review?.answers.map((a) => [a.ordinal, a.text, a.answer])).toEqual([
          [1, 'Записаны цели и не-цели?', true],
          [2, 'Описаны альтернативы?', true],
          [3, 'Указаны риски?', true],
        ]);
      });

      it('FR-WORK-09: the executor of the item cannot review his own work -> 403 REVIEW_OWN_ITEM, nothing is stored', async () => {
        const t = await routeTeam(world);
        const spec = await specDone(t);
        const response = await submitReview(world, t.backend, t.team.id, spec, [
          { ordinal: 1, answer: true },
        ]);
        expectProblem('submitReview', response, 403, 'REVIEW_OWN_ITEM');
        expect(await reviewAnswerCount(world, spec.id)).toBe(0);
      });

      it('FR-WORK-09: the member who uploaded the file is its author even if he is not the assignee -> 403 REVIEW_OWN_ITEM', async () => {
        const t = await routeTeam(world);
        const spec = await itemOf(t, 'mini_spec');
        expectOk(
          'uploadArtifactFile',
          await world
            .as(t.frontend)
            .upload(`/v1/teams/${t.team.id}/checklist-items/${spec.id}/files`, pdfFile()),
          201,
        );
        const current = await itemOf(t, 'mini_spec');
        const response = await submitReview(world, t.frontend, t.team.id, current, [
          { ordinal: 1, answer: true },
        ]);
        expectProblem('submitReview', response, 403, 'REVIEW_OWN_ITEM');
      });

      it('FR-WORK-09: one "no" -> the review is not passed; answers are kept per point', async () => {
        const t = await routeTeam(world);
        await specDone(t);
        const spec = await itemOf(t, 'mini_spec');
        const reviewed = expectOk<ChecklistItemDto>(
          'submitReview',
          await submitReview(world, t.frontend, t.team.id, spec, [
            { ordinal: 1, answer: true },
            { ordinal: 2, answer: false },
            { ordinal: 3, answer: true },
          ]),
          200,
        );
        expect(reviewed.review?.passed).toBe(false);
        expect(reviewed.review?.answers.map((a) => a.answer)).toEqual([true, false, true]);
        expect(await reviewAnswerCount(world, spec.id)).toBe(3);
      });

      it('FR-WORK-09: the last answer of the point counts: a second submission replaces the first (one row per point)', async () => {
        const t = await routeTeam(world);
        await specDone(t);
        const spec = await itemOf(t, 'mini_spec');
        const first = expectOk<ChecklistItemDto>(
          'submitReview',
          await submitReview(world, t.frontend, t.team.id, spec, [{ ordinal: 2, answer: false }]),
          200,
        );
        const second = expectOk<ChecklistItemDto>(
          'submitReview',
          await submitReview(world, t.frontend, t.team.id, first, [{ ordinal: 2, answer: true }]),
          200,
        );
        expect(second.review?.answers.find((a) => a.ordinal === 2)?.answer).toBe(true);
        expect(await reviewAnswerCount(world, spec.id)).toBe(1);
      });

      it('FR-WORK-09: answers for only some points leave the others unanswered (null); the review is not passed', async () => {
        const t = await routeTeam(world);
        await specDone(t);
        const spec = await itemOf(t, 'mini_spec');
        const reviewed = expectOk<ChecklistItemDto>(
          'submitReview',
          await submitReview(world, t.frontend, t.team.id, spec, [{ ordinal: 1, answer: true }]),
          200,
        );
        expect(reviewed.review?.passed).toBe(false);
        expect(reviewed.review?.answers.map((a) => a.answer)).toEqual([true, null, null]);
      });

      it('FR-WORK-09: a point that does not exist (ordinal 99) -> 422; an item without a review checklist -> 409 or 422', async () => {
        const t = await routeTeam(world);
        await specDone(t);
        const spec = await itemOf(t, 'mini_spec');
        expect(
          (await submitReview(world, t.frontend, t.team.id, spec, [{ ordinal: 99, answer: true }]))
            .statusCode,
        ).toBe(422);
        const board = await itemOf(t, 'mini_board');
        const response = await submitReview(world, t.frontend, t.team.id, board, [
          { ordinal: 1, answer: true },
        ]);
        expect([409, 422]).toContain(response.statusCode);
      });

      it('FR-WORK-07: a stale version -> 409 VERSION_CONFLICT; an empty answers list -> 400', async () => {
        const t = await routeTeam(world);
        await specDone(t);
        const spec = await itemOf(t, 'mini_spec');
        expectProblem(
          'submitReview',
          await submitReview(world, t.frontend, t.team.id, { ...spec, version: spec.version + 7 }, [
            { ordinal: 1, answer: true },
          ]),
          409,
          'VERSION_CONFLICT',
        );
        expectProblem(
          'submitReview',
          await submitReview(world, t.frontend, t.team.id, spec, []),
          400,
          'VALIDATION_FAILED',
        );
      });
    });

    describe('acceptReviewRisk (FR-WORK-09)', () => {
      const withNoAnswer = async (t: RouteFixture): Promise<ChecklistItemDto> => {
        await specDone(t);
        const spec = await itemOf(t, 'mini_spec');
        return expectOk<ChecklistItemDto>(
          'submitReview',
          await submitReview(world, t.frontend, t.team.id, spec, [
            { ordinal: 1, answer: true },
            { ordinal: 2, answer: false },
            { ordinal: 3, answer: true },
          ]),
          200,
        );
      };

      it('FR-WORK-09: the lead accepts the "no" point as a risk with a reason -> 200, the record names him; the review counts as passed', async () => {
        const t = await routeTeam(world);
        const reviewed = await withNoAnswer(t);
        const accepted = expectOk<ChecklistItemDto>(
          'acceptReviewRisk',
          await acceptRisk(
            world,
            t.lead,
            t.team.id,
            reviewed,
            2,
            'Альтернативы опишем на втором этапе',
          ),
          200,
        );
        const point = accepted.review?.answers.find((a) => a.ordinal === 2);
        expect(point?.acceptedRisk).toMatchObject({
          reason: 'Альтернативы опишем на втором этапе',
          acceptedBy: t.lead.id,
        });
        expect(accepted.review?.passed).toBe(true);
        expect(await riskCount(world, reviewed.id)).toBe(1);
      });

      it('FR-WORK-09: a member who is not the lead -> 403 NOT_TEAM_LEAD; nothing is recorded', async () => {
        const t = await routeTeam(world);
        const reviewed = await withNoAnswer(t);
        expectProblem(
          'acceptReviewRisk',
          await acceptRisk(world, t.frontend, t.team.id, reviewed, 2),
          403,
          'NOT_TEAM_LEAD',
        );
        expect(await riskCount(world, reviewed.id)).toBe(0);
      });

      it('FR-WORK-09: only a point answered "no" can be accepted as a risk (a "yes" point -> 422)', async () => {
        const t = await routeTeam(world);
        const reviewed = await withNoAnswer(t);
        const response = await acceptRisk(world, t.lead, t.team.id, reviewed, 1);
        expect(response.statusCode, response.body).toBe(422);
        expect(await riskCount(world, reviewed.id)).toBe(0);
      });

      it('FR-WORK-09: a reason shorter than 10 characters -> 400 VALIDATION_FAILED; a stale version -> 409 VERSION_CONFLICT', async () => {
        const t = await routeTeam(world);
        const reviewed = await withNoAnswer(t);
        expectProblem(
          'acceptReviewRisk',
          await acceptRisk(world, t.lead, t.team.id, reviewed, 2, 'мало'),
          400,
          'VALIDATION_FAILED',
        );
        expectProblem(
          'acceptReviewRisk',
          await acceptRisk(
            world,
            t.lead,
            t.team.id,
            { ...reviewed, version: reviewed.version + 5 },
            2,
          ),
          409,
          'VERSION_CONFLICT',
        );
      });
    });

    describe('transitionStage (FR-WORK-10, CC-5)', () => {
      it('FR-WORK-10: with everything required done, reviewed and 24 h passed -> 201, stage 1 closed, stage 2 open with its items; optional items do not block', async () => {
        const t = await routeTeam(world);
        await completeStageOne(t);
        expect((await itemOf(t, 'mini_optional')).status).toBe('open');
        const result = await advanceStage(t, 1);
        expect(result).toEqual({ closedOrdinal: 1, openedOrdinal: 2 });
        const stages = await stagesOf(world, t.lead, t.team.id);
        expect(stages.items.map((s) => s.status)).toEqual(['closed', 'open', 'pending']);
        expect(stages.items[0]?.closedAt).toBeTruthy();
        expect(
          Date.parse(stages.items[1]?.dueAt ?? '') - Date.parse(stages.items[1]?.openedAt ?? ''),
        ).toBe(14 * DAY);
        const rows = await stageRows(world, t.team.id);
        expect(rows[0]?.closed_by).toBe(t.lead.id);
        const next = await checklistOf(world, t.lead, t.team.id, 2);
        expect(next.map((i) => i.stepKey).sort()).toEqual([
          'mini_design',
          'mini_notes',
          'mini_retro',
        ]);
        expect(next.every((i) => i.status === 'open' && i.version === 1)).toBe(true);
        expect(await openStageCount(world, t.team.id)).toBe(1);
      });

      it('FR-WORK-10: the executors of the next stage are chosen when it opens (frontend holds the design step)', async () => {
        const t = await routeTeam(world);
        await completeStageOne(t);
        await advanceStage(t, 1);
        expect(await itemOf(t, 'mini_design', 2)).toMatchObject({
          assigneeUserId: t.frontend.id,
          fallbackUsed: false,
        });
      });

      it('FR-WORK-10: right after the start the answer lists everything unmet: required items, the fallback executor and the 24 hours', async () => {
        const t = await routeTeam(world);
        const unmet = await unmetOf(t, 1);
        expect(codesOf(unmet)).toEqual(
          expect.arrayContaining([
            'FALLBACK_ASSIGNEE_MISSING',
            'MIN_TIME_NOT_ELAPSED',
            'REQUIRED_ITEMS_OPEN',
          ]),
        );
        for (const entry of unmet) expect(entry.message.length).toBeGreaterThan(0);
        expect((await stagesOf(world, t.lead, t.team.id)).items[0]?.status).toBe('open');
        expect(await openStageCount(world, t.team.id)).toBe(1);
      });

      it('FR-WORK-10 (C-08): everything is done but less than 24 hours passed -> exactly MIN_TIME_NOT_ELAPSED; after 24 hours -> 201', async () => {
        const t = await routeTeam(world);
        await completeStageOne(t);
        expect(codesOf(await unmetOf(t, 1))).toEqual(['MIN_TIME_NOT_ELAPSED']);
        clockOf(world).advance(23 * 3_600_000);
        expect(codesOf(await unmetOf(t, 1))).toEqual(['MIN_TIME_NOT_ELAPSED']);
        clockOf(world).advance(2 * 3_600_000);
        expectOk('transitionStage', await transition(world, t.lead, t.team.id, 1), 201);
      });

      it('FR-WORK-10: an obligatory item left open -> REQUIRED_ITEMS_OPEN names it; closing it lifts the block', async () => {
        const t = await routeTeam(world);
        await completeStageOne(t);
        const board = await itemOf(t, 'mini_board');
        await world.as(t.backend).patch(`/v1/teams/${t.team.id}/checklist-items/${board.id}`, {
          version: board.version,
          status: 'open',
        });
        waitMinimumStageTime(world);
        const unmet = await unmetOf(t, 1);
        expect(codesOf(unmet)).toEqual(['REQUIRED_ITEMS_OPEN']);
        expect(JSON.stringify(unmet[0])).toContain(board.id);
        await doneWithLink(t, 'mini_board', t.backend);
        expectOk('transitionStage', await transition(world, t.lead, t.team.id, 1), 201);
      });

      it('FR-WORK-09, FR-WORK-10: a review that is not passed -> exactly REVIEW_NOT_PASSED; a risk accepted by the lead lifts it', async () => {
        const t = await routeTeam(world);
        await doneRitual(t, 'mini_kickoff', t.frontend);
        await doneWithLink(t, 'mini_board', t.backend);
        const charter = await itemOf(t, 'mini_charter');
        await assign(world, t.lead, t.team.id, charter, t.frontend.id);
        await doneWithFile(t, 'mini_charter', t.frontend);
        await doneWithFile(t, 'mini_spec', t.backend);
        const spec = await itemOf(t, 'mini_spec');
        const reviewed = expectOk<ChecklistItemDto>(
          'submitReview',
          await submitReview(world, t.frontend, t.team.id, spec, [
            { ordinal: 1, answer: true },
            { ordinal: 2, answer: false },
            { ordinal: 3, answer: true },
          ]),
          200,
        );
        waitMinimumStageTime(world);
        expect(codesOf(await unmetOf(t, 1))).toEqual(['REVIEW_NOT_PASSED']);
        expectOk('acceptReviewRisk', await acceptRisk(world, t.lead, t.team.id, reviewed, 2), 200);
        expectOk('transitionStage', await transition(world, t.lead, t.team.id, 1), 201);
      });

      it('FR-WORK-09: a required item with a review checklist that nobody reviewed -> REVIEW_NOT_PASSED', async () => {
        const t = await routeTeam(world);
        await doneRitual(t, 'mini_kickoff', t.frontend);
        await doneWithLink(t, 'mini_board', t.backend);
        const charter = await itemOf(t, 'mini_charter');
        await assign(world, t.lead, t.team.id, charter, t.frontend.id);
        await doneWithFile(t, 'mini_charter', t.frontend);
        await doneWithFile(t, 'mini_spec', t.backend);
        waitMinimumStageTime(world);
        expect(codesOf(await unmetOf(t, 1))).toEqual(['REVIEW_NOT_PASSED']);
      });

      it('FR-WORK-03, FR-WORK-10: a fallback item with no executor -> FALLBACK_ASSIGNEE_MISSING until the lead names one', async () => {
        const t = await routeTeam(world);
        expect(codesOf(await unmetOf(t, 1))).toContain('FALLBACK_ASSIGNEE_MISSING');
        const charter = await itemOf(t, 'mini_charter');
        expectOk(
          'assignChecklistItem',
          await assign(world, t.lead, t.team.id, charter, t.frontend.id),
          200,
        );
        expect(codesOf(await unmetOf(t, 1))).not.toContain('FALLBACK_ASSIGNEE_MISSING');
      });

      it('FR-WORK-10: being late does not block: 10 days on a 7-day stage -> the stage is overdue and the transition still works', async () => {
        const t = await routeTeam(world);
        await completeStageOne(t);
        clockOf(world).advance(10 * DAY);
        const stages = await stagesOf(world, t.lead, t.team.id);
        expect(stages.items[0]?.overdue).toBe(true);
        expectOk('transitionStage', await transition(world, t.lead, t.team.id, 1), 201);
      });

      it('FR-WORK-10: a stage that is not open -> 409 STAGE_NOT_OPEN (pending stage 2, closed stage 1 again, last stage in the future)', async () => {
        const t = await routeTeam(world);
        expectProblem(
          'transitionStage',
          await transition(world, t.lead, t.team.id, 2),
          409,
          'STAGE_NOT_OPEN',
        );
        expectProblem(
          'transitionStage',
          await transition(world, t.lead, t.team.id, 3),
          409,
          'STAGE_NOT_OPEN',
        );
        await completeStageOne(t);
        await advanceStage(t, 1);
        expectProblem(
          'transitionStage',
          await transition(world, t.lead, t.team.id, 1),
          409,
          'STAGE_NOT_OPEN',
        );
      });

      it('FR-WORK-10: stage 0 or a text instead of a number -> 400; a stage the project does not have -> 404 or 409', async () => {
        const t = await routeTeam(world);
        const bad = await world
          .as(t.lead)
          .post(`/v1/teams/${t.team.id}/stage-transitions`, { fromOrdinal: 0 });
        expectProblem('transitionStage', bad, 400, 'VALIDATION_FAILED');
        const text = await world
          .as(t.lead)
          .post(`/v1/teams/${t.team.id}/stage-transitions`, { fromOrdinal: 'one' });
        expectProblem('transitionStage', text, 400, 'VALIDATION_FAILED');
        const missing = await transition(world, t.lead, t.team.id, 42);
        expect([404, 409]).toContain(missing.statusCode);
      });

      it('FR-WORK-10: only the lead -> a member gets 403 NOT_TEAM_LEAD; a stranger 404; nothing changes', async () => {
        const t = await routeTeam(world);
        await completeStageOne(t);
        waitMinimumStageTime(world);
        expectProblem(
          'transitionStage',
          await transition(world, t.frontend, t.team.id, 1),
          403,
          'NOT_TEAM_LEAD',
        );
        const stranger = await githubUser(world, 'transition-stranger');
        expectProblem(
          'transitionStage',
          await transition(world, stranger, t.team.id, 1),
          404,
          'NOT_FOUND',
        );
        expect((await stageRows(world, t.team.id)).map((s) => s.status)).toEqual([
          'open',
          'pending',
          'pending',
        ]);
      });

      it('FR-WORK-08: the same key twice returns the stored 201 (the next stage is opened once)', async () => {
        const t = await routeTeam(world);
        await completeStageOne(t);
        waitMinimumStageTime(world);
        const key = randomUUID();
        const first = await transition(world, t.lead, t.team.id, 1, { key });
        expectOk('transitionStage', first, 201);
        const replay = await transition(world, t.lead, t.team.id, 1, { key });
        expect(replay.statusCode).toBe(201);
        expectReplayed(replay);
        expect(await itemRows(world, t.team.id, 2)).toHaveLength(3);
      });

      it('FR-WORK-10: stages go in order to the end: the last transition closes stage 3 (openedOrdinal null) and no stage stays open', async () => {
        const t = await routeTeam(world);
        await completeStageOne(t);
        await advanceStage(t, 1);
        await completeStageTwo(t);
        await advanceStage(t, 2);
        await doneWithLink(t, 'mini_final_links', t.backend, 3, 'https://example.test/app');
        const last = await advanceStage(t, 3);
        expect(last).toEqual({ closedOrdinal: 3, openedOrdinal: null });
        expect((await stagesOf(world, t.lead, t.team.id)).items.map((s) => s.status)).toEqual([
          'closed',
          'closed',
          'closed',
        ]);
        expect(await openStageCount(world, t.team.id)).toBe(0);
      });

      it('FR-WORK-10: an item of a closed stage cannot be changed any more (the stage is not open) -> 409', async () => {
        const t = await routeTeam(world);
        await completeStageOne(t);
        const board = await itemOf(t, 'mini_board');
        await advanceStage(t, 1);
        const response = await world
          .as(t.backend)
          .patch(`/v1/teams/${t.team.id}/checklist-items/${board.id}`, {
            version: board.version + 1,
            status: 'open',
          });
        expect(response.statusCode, response.body).toBe(409);
        expect(['STAGE_NOT_OPEN', 'INVALID_STATE', 'VERSION_CONFLICT']).toContain(
          response.json<{ code: string }>().code,
        );
      });
    });

    describe('confirmParticipation (FR-WORK-11)', () => {
      it('FR-WORK-18: in a suspended team the confirmation is refused with 409 TEAM_STATUS_BLOCKS_ACTION; a completed team gives 409 INVALID_STATE; nothing is recorded', async () => {
        const url = (t: RouteFixture) => `/v1/teams/${t.team.id}/participation-confirmations`;
        const body = (t: RouteFixture) => ({ userId: t.frontend.id, stageOrdinal: 1 });
        const suspended = await routeTeam(world);
        await world.sql`UPDATE teams.team SET status = 'suspended' WHERE id = ${suspended.team.id}`;
        expectProblem(
          'confirmParticipation',
          await world.as(suspended.lead).post(url(suspended), body(suspended)),
          409,
          'TEAM_STATUS_BLOCKS_ACTION',
        );
        const completed = await routeTeam(world);
        await world.sql`UPDATE teams.team SET status = 'completed' WHERE id = ${completed.team.id}`;
        expectProblem(
          'confirmParticipation',
          await world.as(completed.lead).post(url(completed), body(completed)),
          409,
          'INVALID_STATE',
        );
        expect(await participationCount(world, suspended.team.id, suspended.frontend.id)).toBe(0);
        expect(await participationCount(world, completed.team.id, completed.frontend.id)).toBe(0);
      });

      it('FR-WORK-11: the lead confirms the participation of a member in a stage -> 201 with who confirmed and when; one row', async () => {
        const t = await routeTeam(world);
        const response = await world
          .as(t.lead)
          .post(`/v1/teams/${t.team.id}/participation-confirmations`, {
            userId: t.frontend.id,
            stageOrdinal: 1,
          });
        const body = expectOk<{
          userId: string;
          stageOrdinal: number;
          confirmedBy: string;
          at: string;
        }>('confirmParticipation', response, 201);
        expect(body).toMatchObject({
          userId: t.frontend.id,
          stageOrdinal: 1,
          confirmedBy: t.lead.id,
        });
        expect(Date.parse(body.at)).not.toBeNaN();
        expect(await participationCount(world, t.team.id, t.frontend.id)).toBe(1);
      });

      it('FR-WORK-11: repeating it with a new key does not make a second record', async () => {
        const t = await routeTeam(world);
        const body = { userId: t.frontend.id, stageOrdinal: 1 };
        await world.as(t.lead).post(`/v1/teams/${t.team.id}/participation-confirmations`, body);
        await world.as(t.lead).post(`/v1/teams/${t.team.id}/participation-confirmations`, body);
        expect(await participationCount(world, t.team.id, t.frontend.id)).toBe(1);
      });

      it('FR-WORK-11: a member who is not the lead -> 403 NOT_TEAM_LEAD; a person outside the team as the subject -> 422; a stranger as the caller -> 404', async () => {
        const t = await routeTeam(world);
        const stranger = await githubUser(world, 'participation-stranger');
        const url = `/v1/teams/${t.team.id}/participation-confirmations`;
        expectProblem(
          'confirmParticipation',
          await world.as(t.frontend).post(url, { userId: t.backend.id, stageOrdinal: 1 }),
          403,
          'NOT_TEAM_LEAD',
        );
        const outsider = await world.as(t.lead).post(url, { userId: stranger.id, stageOrdinal: 1 });
        expect(outsider.statusCode, outsider.body).toBe(422);
        expectProblem(
          'confirmParticipation',
          await world.as(stranger).post(url, { userId: t.backend.id, stageOrdinal: 1 }),
          404,
          'NOT_FOUND',
        );
        expect(await participationCount(world, t.team.id, stranger.id)).toBe(0);
      });

      it('FR-WORK-11: a stage the project does not have (ordinal 9) or a bad ordinal (0) is refused', async () => {
        const t = await routeTeam(world);
        const url = `/v1/teams/${t.team.id}/participation-confirmations`;
        expect([404, 422]).toContain(
          (await world.as(t.lead).post(url, { userId: t.frontend.id, stageOrdinal: 9 })).statusCode,
        );
        expectProblem(
          'confirmParticipation',
          await world.as(t.lead).post(url, { userId: t.frontend.id, stageOrdinal: 0 }),
          400,
          'VALIDATION_FAILED',
        );
      });
    });

    describe('a member who leaves during the stage (FR-TEAM-11)', () => {
      it('FR-TEAM-11, FR-WORK-10: the executor of an obligatory item left -> the lead gives it to another and the transition goes through', async () => {
        const t = await routeTeam(world);
        await doneRitual(t, 'mini_kickoff', t.frontend);
        await doneWithLink(t, 'mini_board', t.backend);
        await world.as(t.backend).delete(`/v1/teams/${t.team.id}/members/me`);
        const spec = await (async () => {
          for (let i = 0; i < 200; i += 1) {
            const now = await itemOf(t, 'mini_spec');
            if (now.assigneeUserId === null) return now;
            await new Promise((r) => setTimeout(r, 100));
          }
          throw new Error('the executor was not released');
        })();
        expectOk(
          'assignChecklistItem',
          await assign(world, t.lead, t.team.id, spec, t.frontend.id),
          200,
        );
        const charter = await itemOf(t, 'mini_charter');
        expectOk(
          'assignChecklistItem',
          await assign(world, t.lead, t.team.id, charter, t.frontend.id),
          200,
        );
        await doneWithFile(t, 'mini_charter', t.frontend);
        await doneWithFile(t, 'mini_spec', t.frontend);
        // the lead did not touch the artifact, so he may review it
        await passReview(t, 'mini_spec', t.lead);
        waitMinimumStageTime(world);
        expectOk('transitionStage', await transition(world, t.lead, t.team.id, 1), 201);
      });
    });
  },
);
