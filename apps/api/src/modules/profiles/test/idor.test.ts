import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countOf, expectProblem, type ProblemBody } from '../../../../test/fixtures/assertions.js';
import { PROFILE_OPERATIONS, requestFor, send } from '../../../../test/fixtures/operations.js';
import {
  insertProfile,
  insertResume,
  PROFILE_ROLES,
  PROFILE_STACK,
  RESUME_TEXT,
} from '../../../../test/fixtures/profiles.js';
import { World } from '../../../../test/fixtures/world.js';
import { expectIdorResult, idorMatrix } from '../../../../test/helpers/authz.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

const ADMIN_ONLY = ['createRole', 'updateRole', 'createStackTag', 'updateStackTag'] as const;

describeInfra(
  'S2 profiles: authorization matrix from x-authz (IDOR, FR-PROF-04, FR-PROF-05, FR-AUTH-08)',
  ['db', 'redis'],
  () => {
    let world: World;

    beforeAll(async () => {
      world = await World.start();
      await world.ensureCatalog(PROFILE_ROLES, PROFILE_STACK);
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    describe('idorMatrix of the profile operations', () => {
      it.each(PROFILE_OPERATIONS)(
        'FR-PROF-05: %s has only the cases this slice realises (anonymous, admin on a resume) - a new kind means a test is missing',
        (operationId) => {
          const kinds = idorMatrix(operationId).cases.map((c) => c.kind);
          expect(kinds.every((kind) => kind === 'anonymous' || kind === 'admin')).toBe(true);
        },
      );

      it.each(PROFILE_OPERATIONS)(
        'FR-PROF-05: %s without a session -> 401 as its x-authz says',
        async (operationId) => {
          const anonymous = idorMatrix(operationId).cases.find((c) => c.kind === 'anonymous');
          expect(anonymous, `${operationId} is not public in the contract`).toBeDefined();
          const response = await send(world.anonymous(), requestFor(operationId));
          if (anonymous) expectIdorResult(anonymous, response);
          expectProblem(operationId, response, 401, 'UNAUTHENTICATED');
        },
      );
    });

    describe('foreign resumes: 404, never 403, nothing changes (FR-PROF-04, FR-PROF-05)', () => {
      async function ownerWithResume(label: string) {
        const owner = await world.createUser(label);
        const uploadId = await insertResume(world.sql, owner.id);
        return { owner, uploadId };
      }

      const resumeRow = (uploadId: string) =>
        world.sql<{ status: string; extracted_text: string | null; storage_key: string | null }[]>`
        SELECT status, extracted_text, storage_key FROM profiles.resume_upload WHERE id = ${uploadId}`;

      it.each(['confirmResumeFields', 'deleteResume'] as const)(
        "FR-PROF-05: %s on another user's uploadId -> 404 NOT_FOUND and the resume is untouched",
        async (operationId) => {
          const { uploadId } = await ownerWithResume(`idor-owner-${operationId}`);
          const stranger = await world.createUser(`idor-stranger-${operationId}`);
          const response = await send(world.as(stranger), requestFor(operationId, { uploadId }));
          expectProblem(operationId, response, 404, 'NOT_FOUND');
          const rows = await resumeRow(uploadId);
          expect(rows[0]).toMatchObject({ status: 'done', extracted_text: RESUME_TEXT });
          expect(rows[0]?.storage_key).not.toBeNull();
        },
      );

      it('FR-PROF-05: a foreign uploadId and an unknown one are indistinguishable (no existence oracle)', async () => {
        const { uploadId } = await ownerWithResume('idor-oracle-owner');
        const stranger = await world.createUser('idor-oracle-stranger');
        const foreign = await send(world.as(stranger), requestFor('deleteResume', { uploadId }));
        const unknown = await send(world.as(stranger), requestFor('deleteResume'));
        expect(foreign.statusCode).toBe(unknown.statusCode);
        const strip = (r: typeof foreign): Partial<ProblemBody> => {
          const body: Partial<ProblemBody> & { instance?: string } = r.json();
          delete body.requestId;
          delete body.instance;
          return body;
        };
        expect(strip(foreign)).toEqual(strip(unknown));
      });

      it("FR-PROF-04: getMyResume returns the caller's own upload only", async () => {
        const { owner, uploadId } = await ownerWithResume('idor-own-owner');
        const stranger = await world.createUser('idor-own-stranger');
        expect((await world.as(stranger).get('/v1/me/resume')).statusCode).toBe(404);
        const mine = await world.as(owner).get('/v1/me/resume');
        expect(mine.statusCode).toBe(200);
        expect(mine.json<{ id: string }>().id).toBe(uploadId);
      });

      it("FR-PROF-05: an administrator gets 404 on another user's resume (confirm, delete) and cannot read it", async () => {
        const { owner, uploadId } = await ownerWithResume('idor-admin-owner');
        const admin = await world.createUser('idor-admin', { admin: true });
        const caller = world.as(admin);
        for (const operationId of ['confirmResumeFields', 'deleteResume'] as const) {
          const response = await send(caller, requestFor(operationId, { uploadId }));
          expectProblem(operationId, response, 404, 'NOT_FOUND');
        }
        const own = await caller.get('/v1/me/resume');
        expect(own.statusCode).toBe(404);
        expect(own.body).not.toContain(uploadId);
        expect(own.body).not.toContain(RESUME_TEXT);
        const rows = await resumeRow(uploadId);
        expect(rows).toHaveLength(1);
        expect((await world.as(owner).get('/v1/me/resume')).statusCode).toBe(200);
      });

      it("FR-PROF-05: an administrator uploading a resume creates his own and leaves the others' alone", async () => {
        const { uploadId } = await ownerWithResume('idor-admin-upload-owner');
        const admin = await world.createUser('idor-admin-upload', { admin: true });
        const response = await send(world.as(admin), requestFor('uploadResume'));
        expect(response.statusCode).toBe(202);
        expect(
          await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM profiles.resume_upload WHERE user_id = ${admin.id}`),
        ).toBe(1);
        expect((await resumeRow(uploadId))[0]?.status).toBe('done');
      });

      it('FR-PROF-04: a user cannot confirm fields of a foreign resume into his own profile', async () => {
        const { uploadId } = await ownerWithResume('idor-confirm-owner');
        const stranger = await world.createUser('idor-confirm-stranger');
        await insertProfile(world.sql, stranger.id, { displayName: 'Stranger' });
        const response = await send(
          world.as(stranger),
          requestFor('confirmResumeFields', { uploadId }),
        );
        expect(response.statusCode).toBe(404);
        const rows = await world.sql<{ version: number }[]>`
        SELECT version FROM profiles.profile WHERE user_id = ${stranger.id}`;
        expect(rows[0]?.version).toBe(1);
      });
    });

    describe('catalog administration is for administrators (FR-AUTH-08, FR-PROF-09)', () => {
      it.each(ADMIN_ONLY)(
        'FR-AUTH-08: %s by an ordinary user -> 403 ADMIN_ONLY and the catalog is unchanged',
        async (operationId) => {
          const person = await world.createUser(`idor-plain-${operationId}`);
          const before = await countOf(world.sql<{ n: number }[]>`
        SELECT (SELECT count(*) FROM profiles.role) + (SELECT count(*) FROM profiles.stack_tag) AS n`);
          const response = await send(
            world.as(person),
            requestFor(operationId, { code: 'backend' }),
          );
          expectProblem(operationId, response, 403, 'ADMIN_ONLY');
          const after = await countOf(world.sql<{ n: number }[]>`
        SELECT (SELECT count(*) FROM profiles.role) + (SELECT count(*) FROM profiles.stack_tag) AS n`);
          expect(after).toBe(before);
          const name = await world.sql<
            { name: string }[]
          >`SELECT name FROM profiles.role WHERE code = 'backend'`;
          expect(name[0]?.name).not.toBe('Renamed');
        },
      );

      it.each(ADMIN_ONLY)('FR-AUTH-08: %s by an administrator is allowed', async (operationId) => {
        const admin = await world.createUser(`idor-adm-${operationId}`, { admin: true });
        const code = `idor_${operationId.toLowerCase()}`.slice(0, 39);
        if (operationId === 'updateRole') await world.ensureCatalog([code]);
        if (operationId === 'updateStackTag') await world.ensureCatalog([], [code]);
        const response = await send(world.as(admin), requestFor(operationId, { code }));
        expect([200, 201]).toContain(response.statusCode);
      });
    });

    describe('public profile does not widen access (FR-PROF-01)', () => {
      it('FR-PROF-01: another user sees only the public fields, whatever the owner stored', async () => {
        const owner = await world.createUser('idor-public-owner', {
          email: world.email('private-mail'),
        });
        await insertProfile(world.sql, owner.id, { weaknesses: ['secret weakness'] });
        await insertResume(world.sql, owner.id);
        const viewer = await world.createUser('idor-public-viewer');
        const response = await world.as(viewer).get(`/v1/users/${owner.id}/profile`);
        expect(response.statusCode).toBe(200);
        for (const secret of [
          owner.email,
          'secret weakness',
          RESUME_TEXT,
          'weaknesses',
          'extractedText',
        ]) {
          expect(response.body, secret).not.toContain(secret);
        }
      });
    });
  },
);
