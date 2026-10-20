import { afterAll, beforeAll, expect, it, describe } from 'vitest';
import { KIB, MIB, pdfFile } from '../../../../test/fixtures/artifact-files.js';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import { startFakeLinkChecker, type FakeLinkChecker } from '../../../../test/fakes/link-checker.js';
import { expectOk } from '../../../../test/fixtures/teams.js';
import {
  advanceStage,
  assign,
  completeStageOne,
  doneRitual,
  doneWithFile,
  doneWithLink,
  itemOf,
  passReview,
  patchItem,
  routeTeam,
  submitReview,
  transition,
  uploadFile,
  type ArtifactFileDto,
  type ChecklistItemDto,
  type RouteFixture,
  type UnmetDto,
} from '../../../../test/fixtures/workspace.js';
import {
  fileRows,
  itemRow,
  itemRows,
  openStageCount,
  stageRows,
  usageOf,
} from '../../../../test/fixtures/workspace-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

/*
 * S5-14: edge cases found while implementing slice 5, not covered by the scenarios written before the
 * code (S5-01): links (spelling, length, what is queued, the way out of a rejected link), automatic
 * checks in the transition (which items are judged, the order of the conditions, a refused transition
 * changes nothing), the status of the team for every write, file size boundaries, `sha_dedup` after a
 * deletion, and a version conflict after a review.
 */

const BLOCKED = { ok: false, reason: 'BLOCKED_ADDRESS', httpStatus: null } as const;
const OK = { ok: true, reason: null, httpStatus: 200 } as const;
const MAX_LINK_LENGTH = 2048;

describeInfra(
  'S5 workspace: edge cases of links, checks, transition, status and files (S5-14)',
  ['db', 'redis'],
  () => {
    let world: World;
    let checker: FakeLinkChecker;
    const clock = new FakeClock(Date.now());

    beforeAll(async () => {
      world = await startWorld({ clock });
      checker = startFakeLinkChecker(world.queuePrefix);
    });

    afterAll(async () => {
      await checker?.close();
      if (!world) return;
      await world.close();
    });

    const patch = async (fx: RouteFixture, stepKey: string, body: Record<string, unknown>) => {
      const item = await itemOf(fx, stepKey);
      return patchItem(world, fx.backend, fx.team.id, item.id, { version: item.version, ...body });
    };
    const statusIs = (itemId: string, status: string) => async () =>
      (await itemRow(world, itemId)).link_status === status;
    const setTeamStatus = (teamId: string, status: string) =>
      world.sql`UPDATE teams.team SET status = ${status} WHERE id = ${teamId}`;

    describe('links', () => {
      it('FR-WORK-04, SEC-05: links the spelling refuses are not counted against the 30 saves per hour (only a stored link costs one)', async () => {
        const fx = await routeTeam(world);
        for (let i = 0; i < 31; i += 1) {
          const response = await patch(fx, 'mini_board', { linkUrl: `https://127.0.0.${i}/x` });
          expectProblem('updateChecklistItem', response, 422, 'LINK_REJECTED');
        }
        for (let i = 0; i < 30; i += 1) {
          const response = await patch(fx, 'mini_board', { linkUrl: `https://example.test/${i}` });
          expect(response.statusCode, `valid save ${i + 1}: ${response.body}`).toBe(200);
        }
      });

      it('FR-WORK-04: a link of exactly 2048 characters is stored and checked; one character more is a 400 and nothing changes', async () => {
        const fx = await routeTeam(world);
        const base = 'https://example.test/';
        const longest = `${base}${'a'.repeat(MAX_LINK_LENGTH - base.length)}`;
        const stored = expectOk<ChecklistItemDto>(
          'updateChecklistItem',
          await patch(fx, 'mini_board', { linkUrl: longest }),
          200,
        );
        expect(stored.linkUrl).toHaveLength(MAX_LINK_LENGTH);
        await waitFor(statusIs(stored.id, 'ok'), 15_000);
        expectProblem(
          'updateChecklistItem',
          await patch(fx, 'mini_board', { linkUrl: `${longest}a` }),
          400,
          'VALIDATION_FAILED',
        );
        expect((await itemRow(world, stored.id)).link_url).toBe(longest);
      });

      it('FR-WORK-06: the external link of a ritual is judged by its spelling but never sent to the link-checker, its status stays none', async () => {
        const fx = await routeTeam(world);
        const before = checker.seen.length;
        const kickoff = await itemOf(fx, 'mini_kickoff');
        const saved = expectOk<ChecklistItemDto>(
          'updateChecklistItem',
          await patchItem(world, fx.frontend, fx.team.id, kickoff.id, {
            version: kickoff.version,
            externalUrl: 'https://meet.example.test/room-7',
          }),
          200,
        );
        expect(saved).toMatchObject({
          externalUrl: 'https://meet.example.test/room-7',
          linkStatus: 'none',
        });
        await new Promise((resolve) => setTimeout(resolve, 800));
        expect(checker.seen.slice(before).filter((u) => u.includes('room-7'))).toEqual([]);
        const cleared = expectOk<ChecklistItemDto>(
          'updateChecklistItem',
          await patchItem(world, fx.frontend, fx.team.id, kickoff.id, {
            version: saved.version,
            externalUrl: null,
          }),
          200,
        );
        expect(cleared.externalUrl ?? null).toBeNull();
      });

      it('FR-PLAY-08: the way out of a rejected link is to reopen the item or to clear the link; both are allowed, closing it with the rejected link is not', async () => {
        checker.respondWith((url) => (url.includes('sneaky') ? BLOCKED : OK));
        const fx = await routeTeam(world);
        await checker.pause();
        const closed = await doneWithLink(
          fx,
          'mini_board',
          fx.backend,
          1,
          'https://sneaky.example.test/',
        );
        checker.resume();
        await waitFor(statusIs(closed.id, 'rejected'), 15_000);

        const rejected = await itemOf(fx, 'mini_board');
        const reopened = expectOk<ChecklistItemDto>(
          'updateChecklistItem',
          await patchItem(world, fx.backend, fx.team.id, rejected.id, {
            version: rejected.version,
            status: 'open',
          }),
          200,
        );
        expect(reopened).toMatchObject({ status: 'open', linkStatus: 'rejected' });
        expectProblem(
          'updateChecklistItem',
          await patchItem(world, fx.backend, fx.team.id, reopened.id, {
            version: reopened.version,
            status: 'done',
          }),
          422,
          'LINK_REJECTED',
        );
        const cleared = expectOk<ChecklistItemDto>(
          'updateChecklistItem',
          await patchItem(world, fx.backend, fx.team.id, reopened.id, {
            version: reopened.version,
            linkUrl: null,
          }),
          200,
        );
        expect(cleared).toMatchObject({ linkStatus: 'none' });
        expect(cleared.linkUrl ?? null).toBeNull();
        // Without a link a step that asks for one cannot be closed either.
        expectProblem(
          'updateChecklistItem',
          await patchItem(world, fx.backend, fx.team.id, cleared.id, {
            version: cleared.version,
            status: 'done',
          }),
          422,
          'VALIDATION_FAILED',
        );
        checker.respondWith(() => OK);
      });
    });

    describe('automatic checks in the transition', () => {
      const unmetOf = async (fx: RouteFixture, from: number): Promise<UnmetDto[]> => {
        const response = await transition(world, fx.lead, fx.team.id, from);
        const problem = expectProblem('transitionStage', response, 409, 'STAGE_TRANSITION_BLOCKED');
        return (problem as unknown as { unmet: UnmetDto[] }).unmet;
      };
      const stageClosedEvents = async (teamId: string): Promise<number> => {
        const rows = await world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM platform.outbox_event
           WHERE module = 'workspace' AND type = 'stage_closed' AND payload->>'teamId' = ${teamId}`;
        return rows[0]?.n ?? Number.NaN;
      };

      it('FR-WORK-10, FR-PLAY-08: an unreviewed spec, the first 24 hours and a rejected link are three conditions, in the order of the contract; the refusal changes nothing', async () => {
        checker.respondWith(() => OK);
        const fx = await routeTeam(world);
        await checker.pause();
        await doneRitual(fx, 'mini_kickoff', fx.frontend);
        await doneWithLink(fx, 'mini_board', fx.backend);
        const charter = await itemOf(fx, 'mini_charter');
        await assign(world, fx.lead, fx.team.id, charter, fx.frontend.id);
        await doneWithFile(fx, 'mini_charter', fx.frontend);
        await doneWithFile(fx, 'mini_spec', fx.backend);
        const board = await itemOf(fx, 'mini_board');
        checker.respondWith(() => BLOCKED);
        checker.resume();
        await waitFor(statusIs(board.id, 'rejected'), 15_000);

        const rowsBefore = await itemRows(world, fx.team.id);
        const unmet = await unmetOf(fx, 1);
        expect(unmet.map((u) => u.code)).toEqual([
          'REVIEW_NOT_PASSED',
          'MIN_TIME_NOT_ELAPSED',
          'AUTO_CHECKS_FAILED',
        ]);
        expect(unmet[2]?.data).toMatchObject({
          itemIds: [board.id],
          stepKeys: ['mini_board'],
          checks: { mini_board: ['link_https'] },
        });
        // Nothing happened: stage 1 is still the only open stage, stage 2 has no items, no event went out.
        expect((await stageRows(world, fx.team.id)).map((s) => s.status)).toEqual([
          'open',
          'pending',
          'pending',
        ]);
        expect(await openStageCount(world, fx.team.id)).toBe(1);
        expect(await itemRows(world, fx.team.id)).toEqual(rowsBefore);
        expect(await stageClosedEvents(fx.team.id)).toBe(0);
        checker.respondWith(() => OK);
      });

      it('FR-PLAY-08: only required items are judged: an optional item closed with a link the checker later rejects does not block the stage', async () => {
        checker.respondWith(() => OK);
        const fx = await routeTeam(world);
        await checker.pause();
        const optional = await itemOf(fx, 'mini_optional');
        const saved = expectOk<ChecklistItemDto>(
          'updateChecklistItem',
          await patchItem(world, fx.backend, fx.team.id, optional.id, {
            version: optional.version,
            linkUrl: 'https://optional.example.test/doc',
          }),
          200,
        );
        expectOk(
          'updateChecklistItem',
          await patchItem(world, fx.backend, fx.team.id, saved.id, {
            version: saved.version,
            status: 'done',
          }),
          200,
        );
        await completeStageOne(fx);
        checker.respondWith((url) => (url.includes('optional.example') ? BLOCKED : OK));
        checker.resume();
        await waitFor(statusIs(optional.id, 'rejected'), 15_000);
        expect(await advanceStage(fx, 1)).toEqual({ closedOrdinal: 1, openedOrdinal: 2 });
        checker.respondWith(() => OK);
      });

      it('FR-WORK-10: the transition judges the state at the moment of the request: a link rejected after a first refusal and replaced by a good one lets the stage close at once', async () => {
        checker.respondWith(() => OK);
        const fx = await routeTeam(world);
        await completeStageOne(fx);
        const board = await itemOf(fx, 'mini_board');
        await waitFor(statusIs(board.id, 'ok'), 15_000);
        await world.sql`
          UPDATE workspace.checklist_item SET link_status = 'rejected' WHERE id = ${board.id}`;
        clock.advance(25 * 3_600_000);
        expect((await unmetOf(fx, 1)).map((u) => u.code)).toEqual(['AUTO_CHECKS_FAILED']);
        expectOk(
          'updateChecklistItem',
          await patchItem(world, fx.backend, fx.team.id, board.id, {
            version: board.version,
            linkUrl: 'https://example.test/replacement',
          }),
          200,
        );
        expectOk('transitionStage', await transition(world, fx.lead, fx.team.id, 1), 201);
      });
    });

    describe('the status of the team decides every write (FR-WORK-18)', () => {
      it('a team that is voting lets its members work but stops the lead: item writes pass, assignment and transition -> 409 TEAM_STATUS_BLOCKS_ACTION', async () => {
        const fx = await routeTeam(world);
        await setTeamStatus(fx.team.id, 'voting');
        const saved = await patch(fx, 'mini_board', {
          linkUrl: 'https://example.test/while-voting',
        });
        expect(saved.statusCode, saved.body).toBe(200);
        const charter = await itemOf(fx, 'mini_charter');
        expectProblem(
          'assignChecklistItem',
          await assign(world, fx.lead, fx.team.id, charter, fx.frontend.id),
          409,
          'TEAM_STATUS_BLOCKS_ACTION',
        );
        expectProblem(
          'transitionStage',
          await transition(world, fx.lead, fx.team.id, 1),
          409,
          'TEAM_STATUS_BLOCKS_ACTION',
        );
        await setTeamStatus(fx.team.id, 'active');
        expectOk(
          'assignChecklistItem',
          await assign(
            world,
            fx.lead,
            fx.team.id,
            await itemOf(fx, 'mini_charter'),
            fx.frontend.id,
          ),
          200,
        );
      });

      it.each(['completed', 'archived'])(
        'a %s project takes no more writes from anybody: item and file -> 409 INVALID_STATE, nothing changes',
        async (status) => {
          const fx = await routeTeam(world);
          const item = await itemOf(fx, 'mini_board');
          await setTeamStatus(fx.team.id, status);
          expectProblem(
            'updateChecklistItem',
            await patchItem(world, fx.backend, fx.team.id, item.id, {
              version: item.version,
              linkUrl: 'https://example.test/late',
            }),
            409,
            'INVALID_STATE',
          );
          const spec = await itemOf(fx, 'mini_spec');
          expectProblem(
            'uploadArtifactFile',
            await uploadFile(world, fx.backend, fx.team.id, spec.id),
            409,
            'INVALID_STATE',
          );
          expect(await usageOf(world, fx.team.id)).toEqual({ files: 0, bytes: 0 });
          expect((await itemRow(world, item.id)).version).toBe(item.version);
        },
      );

      it('a suspended team stops uploads, deletions, reviews, risk acceptances and fallback reverts as well (read-only), and works again after the suspension', async () => {
        const fx = await routeTeam(world);
        const spec = await itemOf(fx, 'mini_spec');
        const file = expectOk<ArtifactFileDto>(
          'uploadArtifactFile',
          await uploadFile(world, fx.backend, fx.team.id, spec.id),
          201,
        );
        const current = await itemOf(fx, 'mini_spec');
        await world.sql`
          UPDATE teams.team SET status = 'suspended', suspended_at = now() WHERE id = ${fx.team.id}`;
        const blocked = (operationId: string, response: Awaited<ReturnType<typeof uploadFile>>) =>
          expectProblem(operationId, response, 409, 'TEAM_STATUS_BLOCKS_ACTION');
        blocked('uploadArtifactFile', await uploadFile(world, fx.backend, fx.team.id, spec.id));
        blocked(
          'deleteArtifactFile',
          await world
            .as(fx.backend)
            .delete(`/v1/teams/${fx.team.id}/checklist-items/${spec.id}/files/${file.id}`),
        );
        blocked(
          'submitReview',
          await submitReview(world, fx.frontend, fx.team.id, current, [
            { ordinal: 1, answer: true },
          ]),
        );
        blocked(
          'acceptReviewRisk',
          await world
            .as(fx.lead)
            .post(`/v1/teams/${fx.team.id}/checklist-items/${spec.id}/review/risk-acceptances`, {
              version: current.version,
              ordinal: 1,
              reason: 'Принимаем риск ради срока этапа',
            }),
        );
        const charter = await itemOf(fx, 'mini_charter');
        blocked(
          'revertFallback',
          await world
            .as(fx.lead)
            .post(`/v1/teams/${fx.team.id}/checklist-items/${charter.id}/fallback-reverts`, {
              version: charter.version,
            }),
        );
        expect(await fileRows(world, spec.id)).toHaveLength(1);
        expect((await itemRow(world, spec.id)).version).toBe(current.version);

        await world.sql`
          UPDATE teams.team SET status = 'active', suspended_at = NULL WHERE id = ${fx.team.id}`;
        expectOk(
          'uploadArtifactFile',
          await uploadFile(world, fx.backend, fx.team.id, spec.id),
          201,
        );
      });
    });

    describe('files', () => {
      it('FR-WORK-05: the size limits are inclusive: 1023 bytes -> 422 FILE_TOO_SMALL, exactly 1 KiB and exactly 10 MiB are stored', async () => {
        const fx = await routeTeam(world);
        const spec = await itemOf(fx, 'mini_spec');
        expectProblem(
          'uploadArtifactFile',
          await uploadFile(world, fx.backend, fx.team.id, spec.id, pdfFile({ size: KIB - 1 })),
          422,
          'FILE_TOO_SMALL',
        );
        expect(await usageOf(world, fx.team.id)).toEqual({ files: 0, bytes: 0 });
        const smallest = expectOk<ArtifactFileDto>(
          'uploadArtifactFile',
          await uploadFile(world, fx.backend, fx.team.id, spec.id, pdfFile({ size: KIB })),
          201,
        );
        expect(smallest.sizeBytes).toBe(KIB);
        const largest = expectOk<ArtifactFileDto>(
          'uploadArtifactFile',
          await uploadFile(world, fx.backend, fx.team.id, spec.id, pdfFile({ size: 10 * MIB })),
          201,
        );
        expect(largest.sizeBytes).toBe(10 * MIB);
        expect(await usageOf(world, fx.team.id)).toEqual({ files: 2, bytes: KIB + 10 * MIB });
      });
    });

    describe('sha_dedup after deletions (AF-06)', () => {
      const signalsOf = (teamId: string) =>
        world.sql<{ payload: Record<string, unknown> }[]>`
          SELECT payload FROM platform.outbox_event
           WHERE module = 'workspace' AND type = 'step_signal_raised'
             AND payload->>'teamId' = ${teamId} AND payload->>'ruleCode' = 'STEP_sha_dedup'
           ORDER BY id`;
      const upload = async (fx: RouteFixture, file: ReturnType<typeof pdfFile>) =>
        expectOk<ArtifactFileDto>(
          'uploadArtifactFile',
          await uploadFile(world, fx.backend, fx.team.id, (await itemOf(fx, 'mini_spec')).id, file),
          201,
        );

      it('the signal counts the other projects that hold the bytes now: a copy deleted by its project no longer counts', async () => {
        const [a, b, c, d] = [
          await routeTeam(world),
          await routeTeam(world),
          await routeTeam(world),
          await routeTeam(world),
        ];
        const shared = pdfFile();
        // The world clock stands still: step it so that "earlier" is decided by time, not by id.
        const first = await upload(a, shared);
        clock.advance(1_000);
        await upload(b, shared);
        clock.advance(1_000);
        await upload(c, shared);
        await waitFor(
          async () =>
            (await signalsOf(b.team.id)).length + (await signalsOf(c.team.id)).length === 2,
          15_000,
        );
        expect((await signalsOf(b.team.id))[0]?.payload).toMatchObject({ otherTeams: 1 });
        expect((await signalsOf(c.team.id))[0]?.payload).toMatchObject({ otherTeams: 2 });
        expect(await signalsOf(a.team.id)).toEqual([]);

        const specA = await itemOf(a, 'mini_spec');
        const removed = await world
          .as(a.backend)
          .delete(`/v1/teams/${a.team.id}/checklist-items/${specA.id}/files/${first.id}`);
        expect(removed.statusCode, removed.body).toBe(204);

        clock.advance(1_000);
        await upload(d, shared);
        await waitFor(async () => (await signalsOf(d.team.id)).length === 1, 15_000);
        expect((await signalsOf(d.team.id))[0]?.payload).toMatchObject({ otherTeams: 2 });
      });

      it('a copy of bytes that nobody holds any more raises nothing', async () => {
        const [a, b] = [await routeTeam(world), await routeTeam(world)];
        const shared = pdfFile();
        const first = await upload(a, shared);
        clock.advance(1_000);
        const specA = await itemOf(a, 'mini_spec');
        expect(
          (
            await world
              .as(a.backend)
              .delete(`/v1/teams/${a.team.id}/checklist-items/${specA.id}/files/${first.id}`)
          ).statusCode,
        ).toBe(204);
        await upload(b, shared);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(await signalsOf(b.team.id)).toEqual([]);
      });
    });

    describe('version conflicts', () => {
      it('FR-WORK-07: a review raises the version of the item, so a stale write of its executor gets 409 with the review in `current`; applying it again on the current version works', async () => {
        const fx = await routeTeam(world);
        await doneWithFile(fx, 'mini_spec', fx.backend);
        const stale = await itemOf(fx, 'mini_spec');
        await passReview(fx, 'mini_spec', fx.frontend);

        const response = await patchItem(world, fx.backend, fx.team.id, stale.id, {
          version: stale.version,
          status: 'open',
        });
        const problem = expectProblem('updateChecklistItem', response, 409, 'VERSION_CONFLICT');
        const current = problem.current as unknown as ChecklistItemDto;
        expect(current.version).toBeGreaterThan(stale.version);
        expect(current.review?.passed).toBe(true);
        expect((await itemRow(world, stale.id)).version).toBe(current.version);

        const again = await patchItem(world, fx.backend, fx.team.id, stale.id, {
          version: current.version,
          status: 'open',
        });
        expect(again.statusCode, again.body).toBe(200);
      });
    });
  },
);
