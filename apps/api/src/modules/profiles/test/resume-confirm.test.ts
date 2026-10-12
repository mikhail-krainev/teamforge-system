import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import {
  insertProfile,
  insertResume,
  PROFILE_STACK,
  profileInput,
  RESUME_TEXT,
  type ResumeBucket,
  resumeBytes,
} from '../../../../test/fixtures/profiles.js';
import type { World } from '../../../../test/fixtures/world.js';
import { expectMatchesContract } from '../../../../test/helpers/contract.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { confirmUrl, PROFILE_URL, RESUME_URL, useResumeWorld } from './resume-harness.js';
import { pointersOf, type ProfileDto } from './support.js';

describeInfra(
  'S2 profiles: resume confirmation and deletion (FR-PROF-04, FR-PROF-05)',
  ['db', 'redis', 's3'],
  () => {
    const h = useResumeWorld();
    const { newUser, rowOf, uploaded, myResume } = h;
    let world: World;
    let bucket: ResumeBucket;

    beforeAll(() => {
      world = h.world();
      bucket = h.bucket();
    });

    describe('confirmResumeFields', () => {
      const fieldCases: [string, unknown][] = [
        ['displayName', 'Новое Имя'],
        ['timezone', 'Asia/Yekaterinburg'],
        ['hoursPerWeek', 25],
        ['portfolioUrl', 'https://example.test/from-resume'],
        ['stack', ['react']],
        ['rolePrefs', [{ roleCode: 'pm', level: 'middle' }]],
        ['experience', [{ title: 'Из резюме', from: '2020-01-01', to: '2021-01-01' }]],
        ['strengths', ['Из резюме']],
        ['weaknesses', ['Мало опыта']],
      ];
      const comparable = (p: ProfileDto): Record<string, unknown> => ({
        displayName: p.displayName,
        timezone: p.timezone,
        hoursPerWeek: p.hoursPerWeek,
        portfolioUrl: p.portfolioUrl ?? null,
        stack: [...p.stack].sort(),
        rolePrefs: p.rolePrefs,
        experience: p.experience.map((e) => ({ title: e.title, from: e.from, to: e.to ?? null })),
        strengths: p.strengths,
        weaknesses: p.weaknesses,
      });

      it.each(fieldCases)(
        'FR-PROF-04: confirming only %s changes only that field and raises the version',
        async (field, value) => {
          const user = await newUser('conf-field');
          await insertProfile(world.sql, user.id);
          const uploadId = await insertResume(world.sql, user.id, {
            status: 'done',
            keepFile: true,
          });
          const before = (await world.as(user).get(PROFILE_URL)).json<ProfileDto>();

          const response = await world.as(user).post(confirmUrl(uploadId), {
            confirmedFields: { [field]: value },
            keepFile: true,
            profileVersion: 1,
          });
          expect(response.statusCode, response.body).toBe(200);
          expectMatchesContract('confirmResumeFields', response);
          const after = response.json<ProfileDto>();
          expect(after.version).toBe(2);
          expect(after.userId).toBe(user.id);
          const [was, now] = [comparable(before), comparable(after)];
          for (const key of Object.keys(was)) {
            if (key === field) continue;
            expect(now[key], `field ${key} must stay`).toEqual(was[key]);
          }
          expect(now[field]).toEqual(value);
          expect((await world.as(user).get(PROFILE_URL)).json<ProfileDto>()).toEqual(after);
        },
      );

      it('FR-PROF-04: several confirmed fields are all applied, the rest stays', async () => {
        const user = await newUser('conf-multi');
        await insertProfile(world.sql, user.id);
        const uploadId = await insertResume(world.sql, user.id, { status: 'done', keepFile: true });
        const response = await world.as(user).post(confirmUrl(uploadId), {
          confirmedFields: { stack: ['typescript'], hoursPerWeek: 30 },
          keepFile: true,
          profileVersion: 1,
        });
        expect(response.statusCode, response.body).toBe(200);
        const after = response.json<ProfileDto>();
        expect(after).toMatchObject({
          stack: ['typescript'],
          hoursPerWeek: 30,
          displayName: 'Иван Петров',
          version: 2,
        });
        expect(after.rolePrefs).toHaveLength(2);
      });

      it.each(['queued', 'processing', 'failed'] as const)(
        'FR-PROF-04: an upload in status %s cannot be confirmed -> 409 INVALID_STATE, the profile is untouched',
        async (status) => {
          const user = await newUser('conf-state');
          await insertProfile(world.sql, user.id);
          const uploadId = await insertResume(world.sql, user.id, {
            status,
            failureReason: status === 'failed' ? 'corrupted' : null,
          });
          const response = await world.as(user).post(confirmUrl(uploadId), {
            confirmedFields: { stack: ['react'] },
            keepFile: false,
            profileVersion: 1,
          });
          expectProblem('confirmResumeFields', response, 409, 'INVALID_STATE');
          expect((await world.as(user).get(PROFILE_URL)).json<ProfileDto>().version).toBe(1);
          expect((await rowOf(uploadId))?.confirmed_at).toBeNull();
        },
      );

      it('FR-PROF-04: a stale profileVersion -> 409 VERSION_CONFLICT with the current profile, nothing changes', async () => {
        const user = await newUser('conf-stale');
        await insertProfile(world.sql, user.id);
        const uploadId = await insertResume(world.sql, user.id, { status: 'done', keepFile: true });
        const response = await world.as(user).post(confirmUrl(uploadId), {
          confirmedFields: { stack: ['react'] },
          keepFile: true,
          profileVersion: 7,
        });
        const problem = expectProblem('confirmResumeFields', response, 409, 'VERSION_CONFLICT');
        expect(problem.current).toBeDefined();
        const stored = (await world.as(user).get(PROFILE_URL)).json<ProfileDto>();
        expect(stored.version).toBe(1);
        expect([...stored.stack].sort()).toEqual([...PROFILE_STACK].sort());
      });

      it('FR-PROF-04: profileVersion null while a profile exists is a version conflict too', async () => {
        const user = await newUser('conf-null');
        await insertProfile(world.sql, user.id);
        const uploadId = await insertResume(world.sql, user.id, { status: 'done', keepFile: true });
        const response = await world.as(user).post(confirmUrl(uploadId), {
          confirmedFields: { stack: ['react'] },
          keepFile: true,
          profileVersion: null,
        });
        expectProblem('confirmResumeFields', response, 409, 'VERSION_CONFLICT');
      });

      it('FR-PROF-04: a stack tag that is not in the catalog -> 422 with a pointer to the stack, nothing changes', async () => {
        const user = await newUser('conf-unknown');
        await insertProfile(world.sql, user.id);
        const uploadId = await insertResume(world.sql, user.id, { status: 'done', keepFile: true });
        const response = await world.as(user).post(confirmUrl(uploadId), {
          confirmedFields: { stack: ['typescript', 'no_such_tag_zz'] },
          keepFile: true,
          profileVersion: 1,
        });
        const problem = expectProblem('confirmResumeFields', response, 422, 'VALIDATION_FAILED');
        expect(pointersOf(problem).some((p) => p.includes('stack'))).toBe(true);
        expect((await world.as(user).get(PROFILE_URL)).json<ProfileDto>().version).toBe(1);
      });

      it('FR-PROF-04: without a profile, partial fields cannot create one -> 422 and still no profile', async () => {
        const user = await newUser('conf-partial');
        const uploadId = await insertResume(world.sql, user.id, { status: 'done', keepFile: true });
        const response = await world.as(user).post(confirmUrl(uploadId), {
          confirmedFields: { stack: ['typescript'] },
          keepFile: true,
          profileVersion: null,
        });
        expectProblem('confirmResumeFields', response, 422, 'VALIDATION_FAILED');
        expectProblem('getMyProfile', await world.as(user).get(PROFILE_URL), 404, 'NOT_FOUND');
      });

      it('FR-PROF-04: without a profile, a complete set of confirmed fields creates it (version 1)', async () => {
        const user = await newUser('conf-create');
        const uploadId = await insertResume(world.sql, user.id, { status: 'done', keepFile: true });
        const fields: Record<string, unknown> = { ...profileInput() };
        delete fields.version;
        const response = await world.as(user).post(confirmUrl(uploadId), {
          confirmedFields: fields,
          keepFile: true,
          profileVersion: null,
        });
        expect(response.statusCode, response.body).toBe(200);
        expectMatchesContract('confirmResumeFields', response);
        expect(response.json<ProfileDto>()).toMatchObject({
          version: 1,
          userId: user.id,
          displayName: fields.displayName,
        });
        expect((await world.as(user).get(PROFILE_URL)).statusCode).toBe(200);
      });

      it.each([
        ['no keepFile', { confirmedFields: { stack: ['react'] }, profileVersion: 1 }],
        ['no profileVersion', { confirmedFields: { stack: ['react'] }, keepFile: true }],
        ['no confirmedFields', { keepFile: true, profileVersion: 1 }],
        [
          'keepFile as a string',
          { confirmedFields: { stack: ['react'] }, keepFile: 'yes', profileVersion: 1 },
        ],
        [
          'hoursPerWeek 2 in a confirmed field',
          { confirmedFields: { hoursPerWeek: 2 }, keepFile: true, profileVersion: 1 },
        ],
        [
          'an unknown confirmed field',
          { confirmedFields: { isAdmin: true }, keepFile: true, profileVersion: 1 },
        ],
        [
          'a stack tag with capitals',
          { confirmedFields: { stack: ['React'] }, keepFile: true, profileVersion: 1 },
        ],
      ])('FR-PROF-04: %s -> 400 VALIDATION_FAILED', async (_name, body) => {
        const user = await newUser('conf-bad');
        await insertProfile(world.sql, user.id);
        const uploadId = await insertResume(world.sql, user.id, { status: 'done', keepFile: true });
        expectProblem(
          'confirmResumeFields',
          await world.as(user).post(confirmUrl(uploadId), body),
          400,
          'VALIDATION_FAILED',
        );
      });

      it('FR-PROF-05: keepFile=false removes the object and the extracted text, and keeps the confirmed profile', async () => {
        const user = await newUser('conf-drop');
        await insertProfile(world.sql, user.id);
        const uploadId = await uploaded(user);
        const key = (await rowOf(uploadId))?.storage_key ?? '';
        expect(await bucket.exists(key)).toBe(true);
        const response = await world.as(user).post(confirmUrl(uploadId), {
          confirmedFields: { stack: ['typescript'] },
          keepFile: false,
          profileVersion: 1,
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json<ProfileDto>().stack).toEqual(['typescript']);
        expect(await bucket.exists(key)).toBe(false);
        const row = await rowOf(uploadId);
        expect(row).toBeDefined();
        expect(row?.extracted_text).toBeNull();
        expect(row?.storage_key).toBeNull();
        expect(row?.keep_file).toBe(false);
        expect(row?.confirmed_at).not.toBeNull();
        const dto = await myResume(user);
        expect(dto.extractedText ?? null).toBeNull();
      });

      it('FR-PROF-05: keepFile=true keeps the object and the text until the user deletes them', async () => {
        const user = await newUser('conf-keep');
        await insertProfile(world.sql, user.id);
        const uploadId = await uploaded(user);
        const key = (await rowOf(uploadId))?.storage_key ?? '';
        const response = await world.as(user).post(confirmUrl(uploadId), {
          confirmedFields: { stack: ['typescript'] },
          keepFile: true,
          profileVersion: 1,
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(await bucket.exists(key)).toBe(true);
        expect((await bucket.read(key)).equals(resumeBytes('resume.pdf'))).toBe(true);
        const row = await rowOf(uploadId);
        expect(row?.extracted_text).toBe(RESUME_TEXT);
        expect(row?.keep_file).toBe(true);
        expect(row?.confirmed_at).not.toBeNull();
        const dto = await myResume(user);
        expect(dto.keepFile).toBe(true);
        expect(dto.extractedText).toBe(RESUME_TEXT);
      });

      it('FR-WORK-08: the same Idempotency-Key replays the stored 200: one confirmation, the version moves once', async () => {
        const user = await newUser('conf-idem');
        await insertProfile(world.sql, user.id);
        const uploadId = await uploaded(user);
        const key = randomUUID();
        const body = {
          confirmedFields: { stack: ['typescript'] },
          keepFile: false,
          profileVersion: 1,
        };
        const first = await world
          .as(user)
          .post(confirmUrl(uploadId), body, { idempotencyKey: key });
        const second = await world
          .as(user)
          .post(confirmUrl(uploadId), body, { idempotencyKey: key });
        expect(first.statusCode, first.body).toBe(200);
        expect(second.statusCode, second.body).toBe(200);
        expectReplayed(second);
        expect(second.json<ProfileDto>()).toEqual(first.json<ProfileDto>());
        expect((await world.as(user).get(PROFILE_URL)).json<ProfileDto>().version).toBe(2);
      });

      it('FR-WORK-08: without an Idempotency-Key -> 400 IDEMPOTENCY_KEY_MISSING', async () => {
        const user = await newUser('conf-nokey');
        const uploadId = await insertResume(world.sql, user.id, { status: 'done' });
        const response = await world
          .as(user)
          .post(
            confirmUrl(uploadId),
            { confirmedFields: { stack: ['react'] }, keepFile: true, profileVersion: null },
            { idempotencyKey: null },
          );
        expectProblem('confirmResumeFields', response, 400, 'IDEMPOTENCY_KEY_MISSING');
      });

      it('FR-PROF-04: an unknown upload id -> 404 NOT_FOUND; a malformed one -> 400', async () => {
        const user = await newUser('conf-404');
        await insertProfile(world.sql, user.id);
        const body = { confirmedFields: { stack: ['react'] }, keepFile: true, profileVersion: 1 };
        expectProblem(
          'confirmResumeFields',
          await world.as(user).post(confirmUrl(randomUUID()), body),
          404,
          'NOT_FOUND',
        );
        expectProblem(
          'confirmResumeFields',
          await world.as(user).post(confirmUrl('not-a-uuid'), body),
          400,
          'VALIDATION_FAILED',
        );
      });

      it("FR-PROF-04: another user's upload -> 404 (IDOR): their file, row and text are untouched, my profile too", async () => {
        const [owner, intruder] = [await newUser('idor-owner'), await newUser('idor-intruder')] as [
          UserFixture,
          UserFixture,
        ];
        await insertProfile(world.sql, intruder.id);
        const uploadId = await uploaded(owner);
        const key = (await rowOf(uploadId))?.storage_key ?? '';
        const response = await world.as(intruder).post(confirmUrl(uploadId), {
          confirmedFields: { stack: ['react'] },
          keepFile: false,
          profileVersion: 1,
        });
        expectProblem('confirmResumeFields', response, 404, 'NOT_FOUND');
        expect(await bucket.exists(key)).toBe(true);
        const row = await rowOf(uploadId);
        expect(row?.confirmed_at).toBeNull();
        expect(row?.extracted_text).toBe(RESUME_TEXT);
        expect((await world.as(intruder).get(PROFILE_URL)).json<ProfileDto>().version).toBe(1);
        expect(
          await world.sql`SELECT 1 FROM profiles.profile WHERE user_id = ${owner.id}`,
        ).toHaveLength(0);
      });
    });

    describe('deleteResume', () => {
      const remove = (user: UserFixture, id: string, key?: string) =>
        world.as(user).delete(`${RESUME_URL}/${id}`, key ? { idempotencyKey: key } : {});

      it('FR-PROF-05: deleting my upload -> 204 with an empty body; the object, the row and the text are gone', async () => {
        const user = await newUser('del');
        const id = await uploaded(user);
        const key = (await rowOf(id))?.storage_key ?? '';
        expect(await bucket.exists(key)).toBe(true);
        const response = await remove(user, id);
        expect(response.statusCode, response.body).toBe(204);
        expect(response.body).toBe('');
        expectMatchesContract('deleteResume', response);
        expect(await bucket.exists(key)).toBe(false);
        expect(await rowOf(id)).toBeUndefined();
        expectProblem('getMyResume', await world.as(user).get(RESUME_URL), 404, 'NOT_FOUND');
      });

      it('FR-PROF-05: a file kept after confirmation (keepFile=true) is removed by an explicit delete', async () => {
        const user = await newUser('del-kept');
        await insertProfile(world.sql, user.id);
        const id = await uploaded(user);
        const key = (await rowOf(id))?.storage_key ?? '';
        await world.as(user).post(confirmUrl(id), {
          confirmedFields: { stack: ['typescript'] },
          keepFile: true,
          profileVersion: 1,
        });
        expect(await bucket.exists(key)).toBe(true);
        expect((await remove(user, id)).statusCode).toBe(204);
        expect(await bucket.exists(key)).toBe(false);
        expect(await rowOf(id)).toBeUndefined();
      });

      it('FR-PROF-05: deleting again with a new Idempotency-Key -> 404 NOT_FOUND', async () => {
        const user = await newUser('del-twice');
        const id = await uploaded(user);
        expect((await remove(user, id)).statusCode).toBe(204);
        expectProblem('deleteResume', await remove(user, id), 404, 'NOT_FOUND');
      });

      it('FR-WORK-08: repeating the delete with the same Idempotency-Key replays the stored 204', async () => {
        const user = await newUser('del-replay');
        const id = await uploaded(user);
        const key = randomUUID();
        const first = await remove(user, id, key);
        const second = await remove(user, id, key);
        expect(first.statusCode).toBe(204);
        expect(second.statusCode, second.body).toBe(204);
        expect(second.body).toBe('');
        expectReplayed(second);
      });

      it("FR-PROF-05: another user's upload -> 404 NOT_FOUND and their object and row survive", async () => {
        const [owner, intruder] = [await newUser('del-owner'), await newUser('del-intruder')] as [
          UserFixture,
          UserFixture,
        ];
        const id = await uploaded(owner);
        const key = (await rowOf(id))?.storage_key ?? '';
        expectProblem('deleteResume', await remove(intruder, id), 404, 'NOT_FOUND');
        expect(await bucket.exists(key)).toBe(true);
        expect((await rowOf(id))?.extracted_text).toBe(RESUME_TEXT);
        expect((await myResume(owner)).id).toBe(id);
      });

      it("FR-AUTH-08: an administrator gets 404 on someone else's upload as well, and the file survives", async () => {
        const owner = await newUser('del-adm-owner');
        const admin = await newUser('del-admin', { admin: true });
        const id = await uploaded(owner);
        const key = (await rowOf(id))?.storage_key ?? '';
        expectProblem('deleteResume', await remove(admin, id), 404, 'NOT_FOUND');
        expectProblem(
          'confirmResumeFields',
          await world.as(admin).post(confirmUrl(id), {
            confirmedFields: { stack: ['react'] },
            keepFile: true,
            profileVersion: null,
          }),
          404,
          'NOT_FOUND',
        );
        expectProblem('getMyResume', await world.as(admin).get(RESUME_URL), 404, 'NOT_FOUND');
        expect(await bucket.exists(key)).toBe(true);
        expect(await rowOf(id)).toBeDefined();
      });

      it('FR-PROF-05: an unknown id -> 404, a malformed id -> 400, no Idempotency-Key -> 400', async () => {
        const user = await newUser('del-misc');
        expectProblem('deleteResume', await remove(user, randomUUID()), 404, 'NOT_FOUND');
        expectProblem('deleteResume', await remove(user, 'not-a-uuid'), 400, 'VALIDATION_FAILED');
        const response = await world
          .as(user)
          .delete(`${RESUME_URL}/${randomUUID()}`, { idempotencyKey: null });
        expectProblem('deleteResume', response, 400, 'IDEMPOTENCY_KEY_MISSING');
      });
    });
  },
);
