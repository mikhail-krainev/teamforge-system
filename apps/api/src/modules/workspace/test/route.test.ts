import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import {
  DAY,
  expectOk,
  githubUser,
  joinThroughOffer,
  type TeamDto,
} from '../../../../test/fixtures/teams.js';
import {
  assign,
  checklistOf,
  clockOf,
  itemOf,
  patchItem,
  routeTeam,
  stagesOf,
  startedTeamWithRoles,
  today,
  type ChecklistItemDto,
  type RouteFixture,
} from '../../../../test/fixtures/workspace.js';
import { itemRows, openStageCount, stageRows } from '../../../../test/fixtures/workspace-db.js';
import { teamRow } from '../../../../test/fixtures/teams-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

/*
 * S5-01 for S5-04 and S5-05: the route of a started project (stages, checklist, executors, fallback
 * steps) and the writes to its items (version, rituals, links). They fail until the workspace
 * migration and services exist. The mini playbook (3 stages, 28 days) is test/fixtures/playbooks/mini-playbook.yaml.
 */

describeInfra(
  'S5 workspace: the route of a started project (FR-WORK-01..07, -12, -18)',
  ['db', 'redis'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());
    let fx: RouteFixture;

    beforeAll(async () => {
      world = await startWorld({ clock });
      fx = await routeTeam(world);
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    describe('the start opens stage 1 (T4, FR-WORK-01, CC-13)', () => {
      it('FR-WORK-01: listStages -> 3 stages in order; stage 1 open with openedAt and dueAt = openedAt + 7 days, the others pending', async () => {
        const list = await stagesOf(world, fx.lead, fx.team.id);
        expect(list.items.map((s) => [s.ordinal, s.key, s.status])).toEqual([
          [1, 'mini_s1', 'open'],
          [2, 'mini_s2', 'pending'],
          [3, 'mini_s3', 'pending'],
        ]);
        expect(list.items.map((s) => s.durationDays)).toEqual([7, 14, 7]);
        const [first, second] = list.items;
        expect(Date.parse(first?.openedAt ?? '')).toBe(clock.now().getTime());
        expect(Date.parse(first?.dueAt ?? '') - Date.parse(first?.openedAt ?? '')).toBe(7 * DAY);
        expect(second?.openedAt ?? null).toBeNull();
        expect(second?.closedAt ?? null).toBeNull();
        expect(list.items.every((s) => s.overdue === false)).toBe(true);
      });

      it('FR-WORK-12: plannedEndAt = startedAt + sum of duration_days (28 days); getTeam shows the same date', async () => {
        const list = await stagesOf(world, fx.lead, fx.team.id);
        const team = expectOk<TeamDto>(
          'getTeam',
          await world.as(fx.lead).get(`/v1/teams/${fx.team.id}`),
          200,
        );
        expect(Date.parse(list.plannedEndAt ?? '') - Date.parse(team.startedAt ?? '')).toBe(
          28 * DAY,
        );
        expect(list.plannedEndAt).toBe(team.plannedEndAt);
      });

      it('FR-WORK-01: the checklist of stage 1 has one item per step: version 1, open, with the step kind and role', async () => {
        const items = await checklistOf(world, fx.lead, fx.team.id, 1);
        expect(items.map((i) => i.stepKey).sort()).toEqual([
          'mini_board',
          'mini_charter',
          'mini_kickoff',
          'mini_optional',
          'mini_spec',
        ]);
        for (const item of items) {
          expect(item).toMatchObject({
            stageOrdinal: 1,
            status: 'open',
            version: 1,
            files: [],
            linkStatus: 'none',
          });
        }
        const byKey = new Map(items.map((i) => [i.stepKey, i]));
        expect(byKey.get('mini_kickoff')).toMatchObject({
          kind: 'ritual',
          ritualKind: 'call',
          required: true,
          ownerRole: 'any',
        });
        expect(byKey.get('mini_board')).toMatchObject({
          kind: 'artifact',
          submission: 'link',
          required: true,
        });
        expect(byKey.get('mini_optional')).toMatchObject({
          required: false,
          submission: 'either',
          ownerRole: 'qa',
        });
      });

      it('FR-WORK-01: the items of the later stages do not exist until the stage opens (one row per step, only stage 1)', async () => {
        const rows = await itemRows(world, fx.team.id);
        expect(rows).toHaveLength(5);
        expect((await stageRows(world, fx.team.id)).map((s) => s.status)).toEqual([
          'open',
          'pending',
          'pending',
        ]);
        expect(await openStageCount(world, fx.team.id)).toBe(1);
      });

      it('FR-WORK-01: getStageChecklist of a pending stage -> 200 with no items; an unknown ordinal -> 404; a bad ordinal -> 400', async () => {
        expect(await checklistOf(world, fx.lead, fx.team.id, 2)).toEqual([]);
        expectProblem(
          'getStageChecklist',
          await world.as(fx.lead).get(`/v1/teams/${fx.team.id}/stages/99/checklist`),
          404,
          'NOT_FOUND',
        );
        expect(
          (await world.as(fx.lead).get(`/v1/teams/${fx.team.id}/stages/0/checklist`)).statusCode,
        ).toBe(400);
        expect(
          (await world.as(fx.lead).get(`/v1/teams/${fx.team.id}/stages/first/checklist`))
            .statusCode,
        ).toBe(400);
        // The contract (integer, minimum 1, coerced by the validator) refuses everything that is not a whole number.
        for (const bad of ['1.5', '-1', '0', 'NaN']) {
          const response = await world
            .as(fx.lead)
            .get(`/v1/teams/${fx.team.id}/stages/${bad}/checklist`);
          expect(response.statusCode, bad).toBe(400);
        }
        // A number that cannot be a smallint is simply an unknown stage.
        const huge = await world
          .as(fx.lead)
          .get(`/v1/teams/${fx.team.id}/stages/99999999999999999999/checklist`);
        expect(huge.statusCode).toBe(404);
      });

      it('FR-TEAM-10: a team that is still forming has no route: listStages -> 200 with no stages or 409 INVALID_STATE', async () => {
        const forming = await routeTeam(world, { started: false });
        const response = await world.as(forming.lead).get(`/v1/teams/${forming.team.id}/stages`);
        if (response.statusCode === 200) {
          expect(response.json<{ items: unknown[] }>().items).toEqual([]);
        } else {
          expectProblem('listStages', response, 409, 'INVALID_STATE');
        }
        expect(await stageRows(world, forming.team.id)).toEqual([]);
      });
    });

    describe('a playbook without stages cannot start a project (S5 review M6)', () => {
      it('a team pinned to the stub playbook 0.0.1 (no stages) fails to start with 500 and stays forming; no stage is created', async () => {
        const forming = await routeTeam(world, { started: false });
        await world.sql`
          UPDATE teams.team SET playbook_id = '00000000-0000-7000-8000-0000000a0001'
           WHERE id = ${forming.team.id}`;
        const response = await world.as(forming.lead).post(`/v1/teams/${forming.team.id}/start`);
        expect(response.statusCode, response.body).toBe(500);
        expect((await teamRow(world, forming.team.id)).status).toBe('forming');
        expect(await stageRows(world, forming.team.id)).toEqual([]);
      });
    });

    describe('executors and fallback steps (FR-WORK-02, FR-REW-03)', () => {
      it('FR-WORK-02: owner_role any -> no executor; one holder of the role -> he is the executor; nobody and no alternative -> fallback_used', async () => {
        const byKey = new Map(
          (await checklistOf(world, fx.lead, fx.team.id, 1)).map((i) => [i.stepKey, i]),
        );
        expect(byKey.get('mini_kickoff')).toMatchObject({
          assigneeUserId: null,
          fallbackUsed: false,
        });
        expect(byKey.get('mini_board')).toMatchObject({
          assigneeUserId: null,
          fallbackUsed: false,
        });
        expect(byKey.get('mini_spec')).toMatchObject({
          assigneeUserId: fx.backend.id,
          fallbackUsed: false,
        });
        expect(byKey.get('mini_charter')).toMatchObject({
          assigneeUserId: null,
          fallbackUsed: true,
          fallback: { template: 'tpl_charter' },
        });
      });

      it('FR-WORK-02: an optional step with no holder is fallback_used as well, with the fallback shown as advice', async () => {
        const optional = await itemOf(fx, 'mini_optional');
        expect(optional).toMatchObject({
          required: false,
          fallbackUsed: true,
          assigneeUserId: null,
        });
        expect(optional.fallback?.template).toBe('tpl_manual_test_checklist');
      });

      it('FR-WORK-02: several holders of owner_role -> no executor until the lead names one, and no fallback', async () => {
        const t = await startedTeamWithRoles(world, ['backend', 'backend', 'frontend']);
        const spec = (await checklistOf(world, t.lead, t.teamId, 1)).find(
          (i) => i.stepKey === 'mini_spec',
        );
        expect(spec).toMatchObject({ assigneeUserId: null, fallbackUsed: false });
      });

      it('FR-WORK-02: only a holder of an alt role (ba for the charter) -> he is the executor, no fallback', async () => {
        const t = await startedTeamWithRoles(world, ['ba', 'backend']);
        const charter = (await checklistOf(world, t.lead, t.teamId, 1)).find(
          (i) => i.stepKey === 'mini_charter',
        );
        expect(charter).toMatchObject({ assigneeUserId: t.holders[0]?.id, fallbackUsed: false });
      });

      it('FR-WORK-02: a holder of owner_role and of an alt role -> the owner_role holder wins', async () => {
        const t = await startedTeamWithRoles(world, ['ba', 'pm']);
        const charter = (await checklistOf(world, t.lead, t.teamId, 1)).find(
          (i) => i.stepKey === 'mini_charter',
        );
        expect(charter).toMatchObject({ assigneeUserId: t.holders[1]?.id, fallbackUsed: false });
      });

      it('FR-WORK-03: the lead names the executor of a fallback item: 200, version + 1, fallback_used stays true', async () => {
        const t = await routeTeam(world);
        const charter = await itemOf(t, 'mini_charter');
        const response = await assign(world, t.lead, t.team.id, charter, t.frontend.id);
        const updated = expectOk<ChecklistItemDto>('assignChecklistItem', response, 200);
        expect(updated).toMatchObject({
          assigneeUserId: t.frontend.id,
          fallbackUsed: true,
          version: charter.version + 1,
        });
      });

      it('FR-WORK-03: a member who is not the lead cannot name an executor -> 403 NOT_TEAM_LEAD, nothing changes', async () => {
        const t = await routeTeam(world);
        const charter = await itemOf(t, 'mini_charter');
        expectProblem(
          'assignChecklistItem',
          await assign(world, t.frontend, t.team.id, charter, t.frontend.id),
          403,
          'NOT_TEAM_LEAD',
        );
        expect(await itemOf(t, 'mini_charter')).toMatchObject({
          assigneeUserId: null,
          version: charter.version,
        });
      });

      it('FR-WORK-03: a person who is not an active member of the team cannot be the executor -> 422, nothing changes', async () => {
        const t = await routeTeam(world);
        const stranger = await githubUser(world, 'assign-stranger');
        const charter = await itemOf(t, 'mini_charter');
        const response = await assign(world, t.lead, t.team.id, charter, stranger.id);
        expect(response.statusCode, response.body).toBe(422);
        expect(String(response.headers['content-type'])).toContain('application/problem+json');
        expect((await itemOf(t, 'mini_charter')).assigneeUserId).toBeNull();
      });

      it('FR-WORK-07: assignChecklistItem with a stale version -> 409 VERSION_CONFLICT with the current item', async () => {
        const t = await routeTeam(world);
        const charter = await itemOf(t, 'mini_charter');
        expectOk(
          'assignChecklistItem',
          await assign(world, t.lead, t.team.id, charter, t.frontend.id),
          200,
        );
        const stale = await assign(world, t.lead, t.team.id, charter, t.backend.id);
        const problem = expectProblem('assignChecklistItem', stale, 409, 'VERSION_CONFLICT');
        expect(problem.current).toMatchObject({
          id: charter.id,
          assigneeUserId: t.frontend.id,
          version: charter.version + 1,
        });
      });

      it('FR-TEAM-11, FR-TEAM-13: when the executor leaves, his open items stay without an executor; the lead hands them over', async () => {
        const t = await routeTeam(world);
        const spec = await itemOf(t, 'mini_spec');
        expect(spec.assigneeUserId).toBe(t.backend.id);
        const left = await world.as(t.backend).delete(`/v1/teams/${t.team.id}/members/me`);
        expect(left.statusCode, left.body).toBe(204);
        const orphaned = await waitFor(async () => {
          const now = await itemOf(t, 'mini_spec');
          return now.assigneeUserId === null ? now : false;
        }, 20_000);
        expect(orphaned.status).toBe('open');
        const departures = expectOk<{ items: { unassignedItemIds: string[] }[] }>(
          'listDepartures',
          await world.as(t.lead).get(`/v1/teams/${t.team.id}/departures`),
          200,
        );
        expect(departures.items.flatMap((d) => d.unassignedItemIds)).toContain(spec.id);
        const handed = expectOk<ChecklistItemDto>(
          'assignChecklistItem',
          await assign(world, t.lead, t.team.id, orphaned, t.frontend.id),
          200,
        );
        expect(handed.assigneeUserId).toBe(t.frontend.id);
      });

      it('FR-WORK-02: when the last holder of the role leaves, the open item becomes fallback_used (recount on teams.member_left)', async () => {
        const t = await routeTeam(world);
        expect((await itemOf(t, 'mini_spec')).fallbackUsed).toBe(false);
        await world.as(t.backend).delete(`/v1/teams/${t.team.id}/members/me`);
        const recounted = await waitFor(async () => {
          const now = await itemOf(t, 'mini_spec');
          return now.fallbackUsed ? now : false;
        }, 20_000);
        expect(recounted.fallback?.template).toBe('tpl_design_doc');
      });
    });

    describe('revertFallback (FR-WORK-02: the role appeared later)', () => {
      it('FR-WORK-02: after a pm joined, fallback_used is NOT lifted by itself; the lead returns the regular step -> 200, fallback_used false', async () => {
        const t = await routeTeam(world, { openRole: 'pm' });
        const seat = t.team.openSeats[0];
        if (!seat) throw new Error('no pm seat');
        const pm = await githubUser(world, 'late-pm');
        await joinThroughOffer(world, t.lead, t.team.id, seat.id, pm);
        const charter = await itemOf(t, 'mini_charter');
        expect(charter.fallbackUsed).toBe(true);
        const reverted = expectOk<ChecklistItemDto>(
          'revertFallback',
          await world
            .as(t.lead)
            .post(`/v1/teams/${t.team.id}/checklist-items/${charter.id}/fallback-reverts`, {
              version: charter.version,
            }),
          200,
        );
        expect(reverted).toMatchObject({ fallbackUsed: false, version: charter.version + 1 });
      });

      it('FR-WORK-02: an item that does not use the fallback cannot be reverted -> 409 INVALID_STATE', async () => {
        const t = await routeTeam(world);
        const spec = await itemOf(t, 'mini_spec');
        const response = await world
          .as(t.lead)
          .post(`/v1/teams/${t.team.id}/checklist-items/${spec.id}/fallback-reverts`, {
            version: spec.version,
          });
        expectProblem('revertFallback', response, 409, 'INVALID_STATE');
      });

      it('FR-WORK-02: only the lead reverts -> 403 NOT_TEAM_LEAD; a stale version -> 409 VERSION_CONFLICT', async () => {
        const t = await routeTeam(world);
        const charter = await itemOf(t, 'mini_charter');
        const url = `/v1/teams/${t.team.id}/checklist-items/${charter.id}/fallback-reverts`;
        expectProblem(
          'revertFallback',
          await world.as(t.frontend).post(url, { version: charter.version }),
          403,
          'NOT_TEAM_LEAD',
        );
        expectProblem(
          'revertFallback',
          await world.as(t.lead).post(url, { version: charter.version + 5 }),
          409,
          'VERSION_CONFLICT',
        );
      });

      it('FR-WORK-02: while nobody holds the role, the regular step cannot come back (the fallback is the only way)', async () => {
        const t = await routeTeam(world);
        const charter = await itemOf(t, 'mini_charter');
        const response = await world
          .as(t.lead)
          .post(`/v1/teams/${t.team.id}/checklist-items/${charter.id}/fallback-reverts`, {
            version: charter.version,
          });
        expect([409, 422]).toContain(response.statusCode);
        expect((await itemOf(t, 'mini_charter')).fallbackUsed).toBe(true);
      });
    });

    describe('updateChecklistItem (FR-WORK-04, -06, -07, CC-7)', () => {
      it('FR-WORK-07: a write with the current version -> 200, version + 1, the new value; updatedAt moves', async () => {
        const t = await routeTeam(world);
        const board = await itemOf(t, 'mini_board');
        const response = await patchItem(world, t.backend, t.team.id, board.id, {
          version: board.version,
          linkUrl: 'https://example.test/board',
        });
        const updated = expectOk<ChecklistItemDto>('updateChecklistItem', response, 200);
        expect(updated).toMatchObject({
          linkUrl: 'https://example.test/board',
          version: board.version + 1,
          status: 'open',
        });
        expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(board.updatedAt));
      });

      it('FR-WORK-04: a saved link starts unchecked (the check runs in the queue); status done keeps working with an unchecked link', async () => {
        const t = await routeTeam(world);
        const board = await itemOf(t, 'mini_board');
        const saved = expectOk<ChecklistItemDto>(
          'updateChecklistItem',
          await patchItem(world, t.backend, t.team.id, board.id, {
            version: board.version,
            linkUrl: 'https://example.test/board',
          }),
          200,
        );
        expect(saved.linkStatus).toBe('unchecked');
        const done = expectOk<ChecklistItemDto>(
          'updateChecklistItem',
          await patchItem(world, t.backend, t.team.id, saved.id, {
            version: saved.version,
            status: 'done',
          }),
          200,
        );
        expect(done.status).toBe('done');
      });

      it('FR-WORK-07: a write without version -> 400 VERSION_MISSING', async () => {
        const t = await routeTeam(world);
        const board = await itemOf(t, 'mini_board');
        const response = await patchItem(world, t.backend, t.team.id, board.id, {
          linkUrl: 'https://example.test/board',
        });
        expectProblem('updateChecklistItem', response, 400, 'VERSION_MISSING');
      });

      it('FR-WORK-07: a stale version -> 409 VERSION_CONFLICT; current carries the stored item, so the client can reapply', async () => {
        const t = await routeTeam(world);
        const board = await itemOf(t, 'mini_board');
        expectOk(
          'updateChecklistItem',
          await patchItem(world, t.backend, t.team.id, board.id, {
            version: board.version,
            linkUrl: 'https://example.test/one',
          }),
          200,
        );
        const stale = await patchItem(world, t.frontend, t.team.id, board.id, {
          version: board.version,
          linkUrl: 'https://example.test/two',
        });
        const problem = expectProblem('updateChecklistItem', stale, 409, 'VERSION_CONFLICT');
        expect(problem.current).toMatchObject({
          id: board.id,
          linkUrl: 'https://example.test/one',
          version: board.version + 1,
        });
        expect((await itemOf(t, 'mini_board')).linkUrl).toBe('https://example.test/one');
      });

      it('FR-WORK-08: the same key and body twice -> the stored 200, one write (version + 1 once)', async () => {
        const t = await routeTeam(world);
        const board = await itemOf(t, 'mini_board');
        const key = randomUUID();
        const body = { version: board.version, linkUrl: 'https://example.test/board' };
        const first = await patchItem(world, t.backend, t.team.id, board.id, body, { key });
        expectOk('updateChecklistItem', first, 200);
        const replay = await patchItem(world, t.backend, t.team.id, board.id, body, { key });
        expect(replay.statusCode).toBe(200);
        expectReplayed(replay);
        expect((await itemOf(t, 'mini_board')).version).toBe(board.version + 1);
      });

      it('FR-WORK-06: a ritual closed with date, external https link and outcome -> done with the three fields stored', async () => {
        const t = await routeTeam(world);
        const kickoff = await itemOf(t, 'mini_kickoff');
        const fields = {
          heldOn: today(world),
          externalUrl: 'https://meet.example.test/room-1',
          outcome: 'Договорились о цели проекта и правилах работы.',
        };
        const done = expectOk<ChecklistItemDto>(
          'updateChecklistItem',
          await patchItem(world, t.frontend, t.team.id, kickoff.id, {
            version: kickoff.version,
            status: 'done',
            ...fields,
          }),
          200,
        );
        expect(done).toMatchObject({ status: 'done', ...fields });
      });

      it.each([
        [
          'heldOn',
          {
            externalUrl: 'https://meet.example.test/r',
            outcome: 'Итоги встречи записаны полностью.',
          },
        ],
        ['externalUrl', { heldOn: 'TODAY', outcome: 'Итоги встречи записаны полностью.' }],
        ['outcome', { heldOn: 'TODAY', externalUrl: 'https://meet.example.test/r' }],
      ])(
        'FR-WORK-06: a ritual closed without %s -> 422 RITUAL_FIELDS_REQUIRED, the item stays open',
        async (_missing, fields) => {
          const t = await routeTeam(world);
          const kickoff = await itemOf(t, 'mini_kickoff');
          const body = JSON.parse(JSON.stringify(fields).replace('TODAY', today(world))) as Record<
            string,
            unknown
          >;
          const response = await patchItem(world, t.frontend, t.team.id, kickoff.id, {
            version: kickoff.version,
            status: 'done',
            ...body,
          });
          expectProblem('updateChecklistItem', response, 422, 'RITUAL_FIELDS_REQUIRED');
          expect(await itemOf(t, 'mini_kickoff')).toMatchObject({
            status: 'open',
            version: kickoff.version,
          });
        },
      );

      it('FR-WORK-06: an outcome shorter than 20 characters is refused (schema: 400); a day in the future -> 422', async () => {
        const t = await routeTeam(world);
        const kickoff = await itemOf(t, 'mini_kickoff');
        const short = await patchItem(world, t.frontend, t.team.id, kickoff.id, {
          version: kickoff.version,
          status: 'done',
          heldOn: today(world),
          externalUrl: 'https://meet.example.test/r',
          outcome: 'коротко',
        });
        expectProblem('updateChecklistItem', short, 400, 'VALIDATION_FAILED');
        const tomorrow = new Date(clock.now().getTime() + 2 * DAY).toISOString().slice(0, 10);
        const future = await patchItem(world, t.frontend, t.team.id, kickoff.id, {
          version: kickoff.version,
          status: 'done',
          heldOn: tomorrow,
          externalUrl: 'https://meet.example.test/r',
          outcome: 'Итоги встречи записаны полностью.',
        });
        expect(future.statusCode, future.body).toBe(422);
      });

      it('FR-WORK-06: a day before the stage was opened -> 422', async () => {
        const t = await routeTeam(world);
        const kickoff = await itemOf(t, 'mini_kickoff');
        const before = new Date(clock.now().getTime() - 3 * DAY).toISOString().slice(0, 10);
        const response = await patchItem(world, t.frontend, t.team.id, kickoff.id, {
          version: kickoff.version,
          status: 'done',
          heldOn: before,
          externalUrl: 'https://meet.example.test/r',
          outcome: 'Итоги встречи записаны полностью.',
        });
        expect(response.statusCode, response.body).toBe(422);
      });

      it('FR-WORK-05, FR-WORK-04: an artifact item cannot be closed with nothing submitted (no link, no file) -> 422', async () => {
        const t = await routeTeam(world);
        const board = await itemOf(t, 'mini_board');
        const link = await patchItem(world, t.backend, t.team.id, board.id, {
          version: board.version,
          status: 'done',
        });
        expect(link.statusCode, link.body).toBe(422);
        const spec = await itemOf(t, 'mini_spec');
        const file = await patchItem(world, t.backend, t.team.id, spec.id, {
          version: spec.version,
          status: 'done',
        });
        expect(file.statusCode, file.body).toBe(422);
        expect((await itemOf(t, 'mini_spec')).status).toBe('open');
      });

      it('FR-WORK-07: reopening a done item is allowed while its stage is open (done -> open, version + 1)', async () => {
        const t = await routeTeam(world);
        const kickoff = await itemOf(t, 'mini_kickoff');
        const fields = {
          heldOn: today(world),
          externalUrl: 'https://meet.example.test/r',
          outcome: 'Итоги встречи записаны полностью.',
        };
        const done = expectOk<ChecklistItemDto>(
          'updateChecklistItem',
          await patchItem(world, t.frontend, t.team.id, kickoff.id, {
            version: kickoff.version,
            status: 'done',
            ...fields,
          }),
          200,
        );
        const reopened = expectOk<ChecklistItemDto>(
          'updateChecklistItem',
          await patchItem(world, t.frontend, t.team.id, done.id, {
            version: done.version,
            status: 'open',
          }),
          200,
        );
        expect(reopened).toMatchObject({ status: 'open', version: done.version + 1 });
      });

      it('FR-WORK-17: the contribution role is a role code of the catalog; an invalid code -> 400', async () => {
        const t = await routeTeam(world);
        const spec = await itemOf(t, 'mini_spec');
        const bad = await patchItem(world, t.backend, t.team.id, spec.id, {
          version: spec.version,
          roleCode: 'NOT A ROLE',
        });
        expectProblem('updateChecklistItem', bad, 400, 'VALIDATION_FAILED');
        const good = expectOk<ChecklistItemDto>(
          'updateChecklistItem',
          await patchItem(world, t.backend, t.team.id, spec.id, {
            version: spec.version,
            roleCode: 'backend',
          }),
          200,
        );
        expect(good.roleCode).toBe('backend');
      });

      it('FR-WORK-07: unknown fields in the body are refused (additionalProperties: false); a foreign field like teamId is not applied', async () => {
        const t = await routeTeam(world);
        const board = await itemOf(t, 'mini_board');
        const response = await patchItem(world, t.backend, t.team.id, board.id, {
          version: board.version,
          teamId: randomUUID(),
          assigneeUserId: t.lead.id,
        });
        expectProblem('updateChecklistItem', response, 400, 'VALIDATION_FAILED');
        expect(await itemOf(t, 'mini_board')).toMatchObject({
          assigneeUserId: null,
          version: board.version,
        });
      });
    });

    describe('a suspended team (FR-WORK-18)', () => {
      it('FR-WORK-18: in a suspended team item writes, assignments and transitions fail with 409 TEAM_STATUS_BLOCKS_ACTION', async () => {
        const t = await routeTeam(world);
        const board = await itemOf(t, 'mini_board');
        clockOf(world).advance(121 * DAY);
        await world.runMaintenance('max-duration-scan');
        await waitFor(async () => (await teamRow(world, t.team.id)).status === 'suspended', 20_000);
        expectProblem(
          'updateChecklistItem',
          await patchItem(world, t.backend, t.team.id, board.id, {
            version: board.version,
            linkUrl: 'https://example.test/board',
          }),
          409,
          'TEAM_STATUS_BLOCKS_ACTION',
        );
        const charter = await itemOf(t, 'mini_charter');
        expectProblem(
          'assignChecklistItem',
          await assign(world, t.lead, t.team.id, charter, t.frontend.id),
          409,
          'TEAM_STATUS_BLOCKS_ACTION',
        );
        const transition = await world
          .as(t.lead)
          .post(`/v1/teams/${t.team.id}/stage-transitions`, { fromOrdinal: 1 });
        expectProblem('transitionStage', transition, 409, 'TEAM_STATUS_BLOCKS_ACTION');
      });
    });
  },
);
