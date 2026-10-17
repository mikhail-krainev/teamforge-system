import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pdfFile } from '../../../../test/fixtures/artifact-files.js';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import { send } from '../../../../test/fixtures/operations.js';
import {
  headersFor,
  requestForWorkspace,
  SLICE5_OPERATIONS,
  WORKSPACE_OPERATIONS,
  type Slice5Operation,
  type WorkspaceContext,
} from '../../../../test/fixtures/operations-workspace.js';
import { adminOf } from '../../../../test/fixtures/playbooks.js';
import { expectOk, githubUser } from '../../../../test/fixtures/teams.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import {
  itemOf,
  routeTeam,
  stagesOf,
  uploadFile,
  type ArtifactFileDto,
  type ChecklistItemDto,
  type RouteFixture,
} from '../../../../test/fixtures/workspace.js';
import { itemRow, usageOf } from '../../../../test/fixtures/workspace-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { expectIdorResult, idorMatrix } from '../../../../test/helpers/authz.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startWorld, stripNoise } from './support.js';

/*
 * S5-01 IDOR matrix (docs/plan.md, "Тесты среза" -> IDOR; SEC-03): the cases are derived from x-authz
 * of the 18 operations of the slice (test/helpers/authz.ts) and realised with two teams. A foreign
 * resource always looks absent (404), a role below the one required gives 403 with a code.
 */

describeInfra(
  'S5 workspace: authorization matrix from x-authz (IDOR, SEC-03)',
  ['db', 'redis', 's3'],
  () => {
    let world: World;
    const clock = new FakeClock(Date.now());
    let a: RouteFixture;
    let b: RouteFixture;
    let stranger: UserFixture;
    let admin: UserFixture;
    let itemA: ChecklistItemDto;
    let itemB: ChecklistItemDto;
    let fileA: ArtifactFileDto;
    let fileB: ArtifactFileDto;

    beforeAll(async () => {
      world = await startWorld({ clock });
      a = await routeTeam(world);
      b = await routeTeam(world);
      stranger = await githubUser(world, 'idor5-stranger');
      admin = await adminOf(world);
      itemA = await itemOf(a, 'mini_spec');
      itemB = await itemOf(b, 'mini_spec');
      fileA = expectOk<ArtifactFileDto>(
        'uploadArtifactFile',
        await uploadFile(world, a.backend, a.team.id, itemA.id),
        201,
      );
      fileB = expectOk<ArtifactFileDto>(
        'uploadArtifactFile',
        await uploadFile(world, b.backend, b.team.id, itemB.id),
        201,
      );
      itemA = await itemOf(a, 'mini_spec');
      itemB = await itemOf(b, 'mini_spec');
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    const contextOf = (): WorkspaceContext => ({
      teamId: a.team.id,
      itemId: itemA.id,
      fileId: fileA.id,
      ordinal: 1,
      userId: a.frontend.id,
      version: itemA.version,
      playbookId: a.playbook.id,
    });

    const call = (
      who: UserFixture | undefined,
      operationId: Slice5Operation,
      context: WorkspaceContext,
    ) => {
      const request = requestForWorkspace(operationId, context);
      const caller = who ? world.as(who) : world.anonymous();
      return send(caller, request, { headers: headersFor(request) });
    };

    describe('(а) without a session -> 401 for every operation', () => {
      it.each(SLICE5_OPERATIONS)('FR-AUTH-03: %s', async (operationId) => {
        const anonymous = idorMatrix(operationId).cases.find((c) => c.kind === 'anonymous');
        expect(anonymous, `${operationId} is public in the contract`).toBeDefined();
        const response = await call(undefined, operationId, contextOf());
        if (anonymous) expectIdorResult(anonymous, response);
        expectProblem(operationId, response, 401, 'UNAUTHENTICATED');
      });
    });

    describe('(б) team-scoped operations: an outsider gets 404, never 403', () => {
      const SCOPED = SLICE5_OPERATIONS.filter((id) =>
        idorMatrix(id).cases.some((c) => c.kind === 'outsider'),
      );

      it('FR-WORK-01: the matrix covers all 12 workspace operations', () => {
        expect([...SCOPED].sort()).toEqual([...WORKSPACE_OPERATIONS].sort());
      });

      it.each(WORKSPACE_OPERATIONS)(
        'FR-WORK-01: %s by a user outside the team',
        async (operationId) => {
          const outsider = idorMatrix(operationId).cases.find((c) => c.kind === 'outsider');
          const before = await itemRow(world, itemA.id);
          const response = await call(stranger, operationId, contextOf());
          if (outsider) expectIdorResult(outsider, response);
          expectProblem(operationId, response, 404, 'NOT_FOUND');
          const after = await itemRow(world, itemA.id);
          expect(after.version).toBe(before.version);
          expect(after.assignee_user_id).toBe(before.assignee_user_id);
        },
      );

      it('FR-WORK-01: a platform administrator is not a member of a team: team operations answer 404 for him as well', async () => {
        expectProblem(
          'listStages',
          await world.as(admin).get(`/v1/teams/${a.team.id}/stages`),
          404,
          'NOT_FOUND',
        );
        expectProblem(
          'getStageChecklist',
          await world.as(admin).get(`/v1/teams/${a.team.id}/stages/1/checklist`),
          404,
          'NOT_FOUND',
        );
      });

      it('FR-WORK-01: a foreign team and an unknown team look the same (no existence oracle)', async () => {
        const foreign = await world.as(stranger).get(`/v1/teams/${a.team.id}/stages`);
        const unknown = await world.as(stranger).get(`/v1/teams/${randomUUID()}/stages`);
        expect(foreign.statusCode).toBe(unknown.statusCode);
        expect(stripNoise(foreign)).toEqual(stripNoise(unknown));
      });

      it('FR-WORK-01: a member of team B asking for team A gets 404 for stages and checklist', async () => {
        expectProblem(
          'listStages',
          await world.as(b.lead).get(`/v1/teams/${a.team.id}/stages`),
          404,
          'NOT_FOUND',
        );
        expectProblem(
          'getStageChecklist',
          await world.as(b.backend).get(`/v1/teams/${a.team.id}/stages/1/checklist`),
          404,
          'NOT_FOUND',
        );
      });
    });

    describe('(в) a nested id of another team gives 404 and changes nothing', () => {
      it('FR-WORK-07: updateChecklistItem with an item of team B under the id of team A -> 404; the item of B is unchanged', async () => {
        const before = await itemRow(world, itemB.id);
        const response = await world
          .as(a.backend)
          .patch(`/v1/teams/${a.team.id}/checklist-items/${itemB.id}`, {
            version: itemB.version,
            outcome: 'Подмена пункта чужой команды.',
          });
        expectProblem('updateChecklistItem', response, 404, 'NOT_FOUND');
        expect((await itemRow(world, itemB.id)).version).toBe(before.version);
      });

      it('FR-WORK-07: the same with the path of team B and the member of A as the caller -> 404', async () => {
        const response = await world
          .as(a.backend)
          .patch(`/v1/teams/${b.team.id}/checklist-items/${itemB.id}`, {
            version: itemB.version,
            outcome: 'Подмена пункта чужой команды.',
          });
        expectProblem('updateChecklistItem', response, 404, 'NOT_FOUND');
      });

      it.each([
        [
          'assignChecklistItem',
          (t: RouteFixture) =>
            world.as(a.lead).put(`/v1/teams/${a.team.id}/checklist-items/${itemB.id}/assignee`, {
              version: itemB.version,
              userId: t.frontend.id,
            }),
        ],
        [
          'revertFallback',
          () =>
            world
              .as(a.lead)
              .post(`/v1/teams/${a.team.id}/checklist-items/${itemB.id}/fallback-reverts`, {
                version: itemB.version,
              }),
        ],
        [
          'submitReview',
          () =>
            world.as(a.frontend).put(`/v1/teams/${a.team.id}/checklist-items/${itemB.id}/review`, {
              version: itemB.version,
              answers: [{ ordinal: 1, answer: true }],
            }),
        ],
        [
          'acceptReviewRisk',
          () =>
            world
              .as(a.lead)
              .post(`/v1/teams/${a.team.id}/checklist-items/${itemB.id}/review/risk-acceptances`, {
                version: itemB.version,
                ordinal: 1,
                reason: 'Подмена чужого пункта',
              }),
        ],
        ['uploadArtifactFile', async () => uploadFile(world, a.backend, a.team.id, itemB.id)],
      ] as const)(
        'FR-WORK-07: %s with an item of team B under the id of team A -> 404, nothing is stored',
        async (operationId, run) => {
          const filesBefore = (await usageOf(world, b.team.id)).files;
          const response = await run(a);
          expectProblem(operationId, response, 404, 'NOT_FOUND');
          expect((await itemRow(world, itemB.id)).version).toBe(itemB.version);
          expect((await usageOf(world, b.team.id)).files).toBe(filesBefore);
        },
      );

      it('FR-WORK-05: getArtifactDownloadUrl with the file of team B under the item of team A -> 404 (no signed link for a foreign project)', async () => {
        const response = await world
          .as(a.lead)
          .get(`/v1/teams/${a.team.id}/checklist-items/${itemA.id}/files/${fileB.id}/download-url`);
        expectProblem('getArtifactDownloadUrl', response, 404, 'NOT_FOUND');
      });

      it('FR-WORK-05: the file of team B with the item of team B but the id of team A in the path -> 404', async () => {
        const response = await world
          .as(a.lead)
          .get(`/v1/teams/${a.team.id}/checklist-items/${itemB.id}/files/${fileB.id}/download-url`);
        expectProblem('getArtifactDownloadUrl', response, 404, 'NOT_FOUND');
      });

      it('FR-WORK-05: deleteArtifactFile with the file of team B under the item of team A -> 404; the file and the quota of B stay', async () => {
        const response = await world
          .as(a.lead)
          .delete(`/v1/teams/${a.team.id}/checklist-items/${itemA.id}/files/${fileB.id}`);
        expectProblem('deleteArtifactFile', response, 404, 'NOT_FOUND');
        expect((await usageOf(world, b.team.id)).files).toBe(1);
      });

      it('FR-WORK-01: getStageChecklist with an ordinal that team A does not have -> 404', async () => {
        expectProblem(
          'getStageChecklist',
          await world.as(a.lead).get(`/v1/teams/${a.team.id}/stages/7/checklist`),
          404,
          'NOT_FOUND',
        );
      });

      it('FR-WORK-11: confirmParticipation for a member of team B in team A -> 422, nothing is recorded', async () => {
        const response = await world
          .as(a.lead)
          .post(`/v1/teams/${a.team.id}/participation-confirmations`, {
            userId: b.frontend.id,
            stageOrdinal: 1,
          });
        expect(response.statusCode, response.body).toBe(422);
      });

      it('FR-WORK-03: the executor must belong to the team of the item: a member of team B is refused', async () => {
        const response = await world
          .as(a.lead)
          .put(`/v1/teams/${a.team.id}/checklist-items/${itemA.id}/assignee`, {
            version: itemA.version,
            userId: b.frontend.id,
          });
        expect(response.statusCode, response.body).toBe(422);
        expect((await itemRow(world, itemA.id)).assignee_user_id).toBe(a.backend.id);
      });
    });

    describe('(г) a role below the required one -> 403 with a code', () => {
      const LEAD_ONLY = WORKSPACE_OPERATIONS.filter((id) =>
        idorMatrix(id).cases.some((c) => c.kind === 'low-role'),
      );

      it('FR-WORK-03, FR-WORK-09, FR-WORK-10, FR-WORK-11: the lead-only operations are assign, revert, acceptRisk, transition and confirmParticipation', () => {
        expect([...LEAD_ONLY].sort()).toEqual(
          [
            'acceptReviewRisk',
            'assignChecklistItem',
            'confirmParticipation',
            'revertFallback',
            'transitionStage',
          ].sort(),
        );
      });

      it.each(LEAD_ONLY)('FR-WORK-03: %s by a member who is not the lead', async (operationId) => {
        const lowRole = idorMatrix(operationId).cases.find((c) => c.kind === 'low-role');
        const response = await call(a.frontend, operationId, contextOf());
        if (lowRole) expectIdorResult(lowRole, response);
        expectProblem(operationId, response, 403, 'NOT_TEAM_LEAD');
      });

      it('FR-WORK-05: deleteArtifactFile by a member who is neither the author nor the lead -> 403 and the file stays', async () => {
        const response = await world
          .as(a.frontend)
          .delete(`/v1/teams/${a.team.id}/checklist-items/${itemA.id}/files/${fileA.id}`);
        expect(response.statusCode, response.body).toBe(403);
        expect(String(response.headers['content-type'])).toContain('application/problem+json');
        expect((await usageOf(world, a.team.id)).files).toBe(1);
      });

      it('FR-AUTH-08: the administrator operations of the playbooks by a regular user -> 403 ADMIN_ONLY', async () => {
        for (const operationId of [
          'adminListPlaybooks',
          'uploadPlaybook',
          'publishPlaybook',
        ] as const) {
          const response = await call(a.lead, operationId, contextOf());
          expectProblem(operationId, response, 403, 'ADMIN_ONLY');
        }
      });
    });

    describe('(д) a team id or a user id in the body is never trusted', () => {
      it('FR-WORK-10: transitionStage with teamId of another team in the body -> 400 (unknown field); no stage of either team moves', async () => {
        const response = await world
          .as(a.lead)
          .post(`/v1/teams/${a.team.id}/stage-transitions`, { fromOrdinal: 1, teamId: b.team.id });
        expectProblem('transitionStage', response, 400, 'VALIDATION_FAILED');
        expect((await stagesOf(world, b.lead, b.team.id)).items[0]?.status).toBe('open');
      });

      it('FR-WORK-07: updateChecklistItem with teamId or assigneeUserId in the body -> 400; the item keeps its executor', async () => {
        const response = await world
          .as(a.backend)
          .patch(`/v1/teams/${a.team.id}/checklist-items/${itemA.id}`, {
            version: itemA.version,
            teamId: b.team.id,
            assigneeUserId: a.lead.id,
          });
        expectProblem('updateChecklistItem', response, 400, 'VALIDATION_FAILED');
        expect((await itemRow(world, itemA.id)).assignee_user_id).toBe(a.backend.id);
      });

      it('FR-WORK-05: uploadArtifactFile cannot carry a team or an uploader: the author is always the caller', async () => {
        const response = await world
          .as(a.frontend)
          .upload(`/v1/teams/${a.team.id}/checklist-items/${itemA.id}/files`, pdfFile());
        const stored = expectOk<ArtifactFileDto>('uploadArtifactFile', response, 201);
        expect(stored.uploadedBy).toBe(a.frontend.id);
      });
    });
  },
);
