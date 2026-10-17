import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pdfFile } from '../../../../test/fixtures/artifact-files.js';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import { startFakeLinkChecker, type FakeLinkChecker } from '../../../../test/fakes/link-checker.js';
import { expectOk } from '../../../../test/fixtures/teams.js';
import {
  advanceStage,
  clockOf,
  completeStageOne,
  itemOf,
  patchItem,
  routeTeam,
  transition,
  uploadFile,
  waitMinimumStageTime,
  type ChecklistItemDto,
  type RouteFixture,
  type UnmetDto,
} from '../../../../test/fixtures/workspace.js';
import { itemRow } from '../../../../test/fixtures/workspace-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

/*
 * S5-09: automatic checks of steps (FR-PLAY-08). The verdict of the link-checker (a code through the
 * `link-check` queue, applied by the worker), the blocking part of `link_https` in the transition
 * (AUTO_CHECKS_FAILED), the sweep that repairs a lost check, and `sha_dedup` (AF-06) as a signal event.
 */

const BLOCKED = { ok: false, reason: 'BLOCKED_ADDRESS', httpStatus: null } as const;
const NOT_FOUND = { ok: false, reason: 'HTTP_STATUS', httpStatus: 404 } as const;
const OK = { ok: true, reason: null, httpStatus: 200 } as const;

describeInfra(
  'S5 workspace: automatic checks and the verdict on links (S5-09, FR-WORK-04, FR-PLAY-08)',
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

    const linkStatusOf = async (itemId: string) => (await itemRow(world, itemId)).link_status;
    const waitForStatus = (itemId: string, status: string) =>
      waitFor(async () => (await linkStatusOf(itemId)) === status, 15_000);

    const saveBoardLink = async (fx: RouteFixture, url: string): Promise<ChecklistItemDto> => {
      const item = await itemOf(fx, 'mini_board');
      return expectOk<ChecklistItemDto>(
        'updateChecklistItem',
        await patchItem(world, fx.backend, fx.team.id, item.id, {
          version: item.version,
          linkUrl: url,
        }),
        200,
      );
    };

    describe('the verdict of the link-checker (FR-WORK-04)', () => {
      it('a link that answers 2xx ends `ok`; the verdict does not move the version of the item', async () => {
        checker.respondWith(() => OK);
        const fx = await routeTeam(world);
        const saved = await saveBoardLink(fx, 'https://example.test/ok-page');
        expect(saved.linkStatus).toBe('unchecked');
        await waitForStatus(saved.id, 'ok');
        const after = await itemOf(fx, 'mini_board');
        expect(after).toMatchObject({ linkStatus: 'ok', version: saved.version });
        expect((await itemRow(world, saved.id)).link_status).toBe('ok');
      });

      it('a link that answers 404 ends `broken` (a warning): the item can still be closed', async () => {
        checker.respondWith(() => NOT_FOUND);
        const fx = await routeTeam(world);
        const saved = await saveBoardLink(fx, 'https://example.test/gone');
        await waitForStatus(saved.id, 'broken');
        const item = await itemOf(fx, 'mini_board');
        expectOk(
          'updateChecklistItem',
          await patchItem(world, fx.backend, fx.team.id, item.id, {
            version: item.version,
            status: 'done',
          }),
          200,
        );
      });

      it('a name that resolves to an internal address ends `rejected`: the item cannot be closed until the link is replaced', async () => {
        checker.respondWith((url) => (url.includes('sneaky') ? BLOCKED : OK));
        const fx = await routeTeam(world);
        const saved = await saveBoardLink(fx, 'https://sneaky.example.test/');
        await waitForStatus(saved.id, 'rejected');
        const item = await itemOf(fx, 'mini_board');
        expectProblem(
          'updateChecklistItem',
          await patchItem(world, fx.backend, fx.team.id, item.id, {
            version: item.version,
            status: 'done',
          }),
          422,
          'LINK_REJECTED',
        );
        const fixed = await patchItem(world, fx.backend, fx.team.id, item.id, {
          version: item.version,
          linkUrl: 'https://example.test/fine',
        });
        expect(fixed.statusCode, fixed.body).toBe(200);
        await waitForStatus(item.id, 'ok');
        const again = await itemOf(fx, 'mini_board');
        expectOk(
          'updateChecklistItem',
          await patchItem(world, fx.backend, fx.team.id, again.id, {
            version: again.version,
            status: 'done',
          }),
          200,
        );
      });

      it('an answer about an address that has been replaced meanwhile is ignored: the verdict is about the current link', async () => {
        const fx = await routeTeam(world);
        await checker.pause();
        const first = await saveBoardLink(fx, 'https://example.test/old-address');
        const second = expectOk<ChecklistItemDto>(
          'updateChecklistItem',
          await patchItem(world, fx.backend, fx.team.id, first.id, {
            version: first.version,
            linkUrl: 'https://example.test/new-address',
          }),
          200,
        );
        // Both checks are queued; the old address would be refused, the new one is fine.
        checker.respondWith((url) => (url.includes('old-address') ? BLOCKED : OK));
        checker.resume();
        await waitFor(() => checker.seen.some((url) => url.includes('new-address')), 15_000);
        await waitFor(() => checker.seen.some((url) => url.includes('old-address')), 15_000);
        await waitForStatus(second.id, 'ok');
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(await itemRow(world, second.id)).toMatchObject({
          link_url: 'https://example.test/new-address',
          link_status: 'ok',
        });
      });
    });

    describe('AUTO_CHECKS_FAILED in the transition (architecture 11.3)', () => {
      it('a done item whose link was rejected after closing blocks the transition with AUTO_CHECKS_FAILED; replacing the link clears it', async () => {
        const fx = await routeTeam(world);
        checker.respondWith(() => OK);
        await checker.pause();
        // The item is closed while the check is still waiting (`unchecked` is not a refusal) ...
        await completeStageOne(fx);
        // ... then the checker answers: the address was internal.
        checker.respondWith((url) => (url.includes('example.test/board') ? BLOCKED : OK));
        checker.resume();
        const board = await itemOf(fx, 'mini_board');
        await waitForStatus(board.id, 'rejected');
        waitMinimumStageTime(world);
        const blocked = await transition(world, fx.lead, fx.team.id, 1);
        const problem = expectProblem('transitionStage', blocked, 409, 'STAGE_TRANSITION_BLOCKED');
        const unmet = (problem as unknown as { unmet: UnmetDto[] }).unmet;
        expect(unmet.map((u) => u.code)).toEqual(['AUTO_CHECKS_FAILED']);
        expect(unmet[0]?.data).toMatchObject({
          itemIds: [board.id],
          stepKeys: ['mini_board'],
          checks: { mini_board: ['link_https'] },
        });
        expect(clockOf(world)).toBe(clock);

        checker.respondWith(() => OK);
        expectOk(
          'updateChecklistItem',
          await patchItem(world, fx.backend, fx.team.id, board.id, {
            version: board.version,
            linkUrl: 'https://example.test/repaired',
          }),
          200,
        );
        await waitForStatus(board.id, 'ok');
        const closed = await transition(world, fx.lead, fx.team.id, 1);
        expect(closed.statusCode, closed.body).toBe(201);
      });

      it('a broken link (404) is only a warning: the transition goes through', async () => {
        const fx = await routeTeam(world);
        checker.respondWith(() => NOT_FOUND);
        await completeStageOne(fx);
        const board = await itemOf(fx, 'mini_board');
        await waitForStatus(board.id, 'broken');
        const result = await advanceStage(fx, 1);
        expect(result).toEqual({ closedOrdinal: 1, openedOrdinal: 2 });
      });
    });

    describe('the sweep repairs a lost check (S5-09)', () => {
      const stuckLink = async (fx: RouteFixture, ageMs: number): Promise<string> => {
        const item = await itemOf(fx, 'mini_board');
        await world.sql`
          UPDATE workspace.checklist_item
             SET link_url = 'https://example.test/lost', link_status = 'unchecked',
                 updated_at = ${new Date(clock.now().getTime() - ageMs)}
           WHERE id = ${item.id}`;
        return item.id;
      };

      it('a link that waits for more than five minutes is queued again and gets its verdict', async () => {
        checker.respondWith(() => OK);
        const fx = await routeTeam(world);
        const id = await stuckLink(fx, 6 * 60_000);
        await world.runMaintenance('link-check-sweep');
        await waitForStatus(id, 'ok');
      });

      it('a link that waited less than five minutes is left alone', async () => {
        const fx = await routeTeam(world);
        const before = checker.seen.length;
        const id = await stuckLink(fx, 60_000);
        await world.runMaintenance('link-check-sweep');
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(await linkStatusOf(id)).toBe('unchecked');
        expect(checker.seen.length).toBe(before);
      });

      it('a link without an answer for an hour is given up as broken, a warning only', async () => {
        const fx = await routeTeam(world);
        const id = await stuckLink(fx, 61 * 60_000);
        await world.runMaintenance('link-check-sweep');
        expect(await linkStatusOf(id)).toBe('broken');
      });
    });

    describe('sha_dedup is a signal, never a block (AF-06, FR-PLAY-08)', () => {
      const signalsOf = (teamId: string) =>
        world.sql<{ payload: Record<string, unknown> }[]>`
          SELECT payload FROM platform.outbox_event
           WHERE module = 'workspace' AND type = 'step_signal_raised'
             AND payload->>'teamId' = ${teamId}
           ORDER BY id`;
      const spec = (fx: RouteFixture) => itemOf(fx, 'mini_spec');
      const upload = async (fx: RouteFixture, item: ChecklistItemDto, file = pdfFile()) =>
        expectOk(
          'uploadArtifactFile',
          await uploadFile(world, fx.backend, fx.team.id, item.id, file),
          201,
        );

      it('the same bytes that another project stored earlier raise STEP_sha_dedup (score 0) for the later upload only; both uploads are accepted', async () => {
        const [a, b] = [await routeTeam(world), await routeTeam(world)];
        const file = pdfFile();
        await upload(a, await spec(a), file);
        clock.advance(1_000);
        await upload(b, await spec(b), file);
        await waitFor(async () => (await signalsOf(b.team.id)).length > 0, 15_000);
        const [signal] = await signalsOf(b.team.id);
        expect(signal?.payload).toMatchObject({
          teamId: b.team.id,
          stepKey: 'mini_spec',
          ruleCode: 'STEP_sha_dedup',
          phase: 'step_check',
          score: 0,
          otherTeams: 1,
        });
        expect(JSON.stringify(signal?.payload)).not.toContain('example');
        expect(await signalsOf(a.team.id)).toEqual([]);
      });

      it('the same bytes twice inside one project, and different bytes in two projects, raise nothing', async () => {
        const [a, b] = [await routeTeam(world), await routeTeam(world)];
        const file = pdfFile();
        await upload(a, await spec(a), file);
        await upload(a, await itemOf(a, 'mini_charter'), file);
        await upload(b, await spec(b), pdfFile());
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(await signalsOf(a.team.id)).toEqual([]);
        expect(await signalsOf(b.team.id)).toEqual([]);
      });

      it('a step that does not ask for sha_dedup raises nothing even for copied bytes', async () => {
        const [a, b] = [await routeTeam(world), await routeTeam(world)];
        const file = pdfFile();
        await upload(a, await spec(a), file);
        await upload(b, await itemOf(b, 'mini_optional'), file);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(await signalsOf(b.team.id)).toEqual([]);
      });
    });
  },
);
