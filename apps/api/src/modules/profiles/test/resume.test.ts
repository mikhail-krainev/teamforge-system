import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ParseResult } from '../../../../test/fakes/resume-worker.js';
import {
  expectProblem,
  expectRateLimited,
  expectReplayed,
  logLinesWith,
} from '../../../../test/fixtures/assertions.js';
import type { UploadFile } from '../../../../test/fixtures/clients.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import { requestFor, send } from '../../../../test/fixtures/operations.js';
import {
  insertProfile,
  RESUME_TEXT,
  type ResumeBucket,
  resumeBytes,
  resumeFile,
} from '../../../../test/fixtures/profiles.js';
import type { World } from '../../../../test/fixtures/world.js';
import { expectMatchesContract } from '../../../../test/helpers/contract.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';
import {
  confirmUrl,
  DOCX_MIME,
  OK_ANSWER,
  PROFILE_URL,
  RESUME_URL,
  useResumeWorld,
} from './resume-harness.js';
import { FAILURE_REASONS, hex, type ProfileDto, type ResumeDto } from './support.js';

describeInfra(
  'S2 profiles: resume upload and parsing (FR-PROF-02..04, FR-AUTH-04)',
  ['db', 'redis', 's3'],
  () => {
    const h = useResumeWorld();
    const {
      newUser,
      fake,
      upload,
      rowOf,
      uploadCount,
      finalStatus,
      uploaded,
      myResume,
      settleUsers,
    } = h;
    let world: World;
    let bucket: ResumeBucket;

    beforeAll(() => {
      world = h.world();
      bucket = h.bucket();
    });

    describe('uploadResume: accepted files', () => {
      it.each([
        ['resume.pdf', 'application/pdf'],
        ['resume.docx', DOCX_MIME],
      ] as const)(
        'FR-PROF-02: a valid %s -> 202 queued; the row and the object in the private bucket match the bytes',
        async (name, mime) => {
          const user = await newUser();
          const bytes = resumeBytes(name);
          const secretName = `cv-${hex(10)}-${name}`;
          const response = await upload(user, resumeFile(name, { filename: secretName }));
          expect(response.statusCode, response.body).toBe(202);
          expectMatchesContract('uploadResume', response);
          const dto = response.json<ResumeDto>();
          expect(dto.status).toBe('queued');
          expect(dto.keepFile).toBe(false);

          const row = await rowOf(dto.id);
          expect(row).toBeDefined();
          expect(row?.user_id).toBe(user.id);
          expect(row?.mime).toBe(mime);
          expect(row?.size_bytes).toBe(bytes.length);
          expect(row?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
          const key = row?.storage_key ?? '';
          expect(key).toMatch(
            /^res\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          );
          expect(key).not.toContain(secretName);
          expect(key).not.toContain(user.id);
          expect(await bucket.exists(key)).toBe(true);
          expect((await bucket.read(key)).equals(bytes)).toBe(true);
          await finalStatus(dto.id);
        },
      );

      it('FR-PROF-02: the same file from two users gets two different random keys and two objects', async () => {
        const [a, b] = [await newUser('twin-a'), await newUser('twin-b')] as [
          UserFixture,
          UserFixture,
        ];
        const idA = (await upload(a)).json<ResumeDto>().id;
        const idB = (await upload(b)).json<ResumeDto>().id;
        const keyA = (await rowOf(idA))?.storage_key ?? '';
        const keyB = (await rowOf(idB))?.storage_key ?? '';
        expect(keyA).not.toBe(keyB);
        expect(await bucket.exists(keyA)).toBe(true);
        expect(await bucket.exists(keyB)).toBe(true);
        await Promise.all([finalStatus(idA), finalStatus(idB)]);
      });

      it('FR-PROF-02: the type comes from the bytes, not from the client name or Content-Type', async () => {
        const user = await newUser();
        const pdfAsExe = await upload(
          user,
          resumeFile('resume.pdf', { filename: 'cv.exe', contentType: 'application/octet-stream' }),
        );
        expect(pdfAsExe.statusCode, pdfAsExe.body).toBe(202);
        const docxAsPdf = await upload(
          user,
          resumeFile('resume.docx', { filename: 'cv.pdf', contentType: 'application/pdf' }),
        );
        expect(docxAsPdf.statusCode, docxAsPdf.body).toBe(202);
        expect((await rowOf(pdfAsExe.json<ResumeDto>().id))?.mime).toBe('application/pdf');
        expect((await rowOf(docxAsPdf.json<ResumeDto>().id))?.mime).toBe(DOCX_MIME);
        await Promise.all([
          finalStatus(pdfAsExe.json<ResumeDto>().id),
          finalStatus(docxAsPdf.json<ResumeDto>().id),
        ]);
      });
    });

    describe('uploadResume: rejected files', () => {
      const fiveMiB = 5 * 1024 * 1024;
      const rejections: [string, () => UploadFile, number[], string | null][] = [
        [
          'an executable renamed to .pdf',
          () => resumeFile('renamed-exe.pdf'),
          [415],
          'FILE_TYPE_REJECTED',
        ],
        [
          'a text file',
          () => ({
            filename: 'notes.txt',
            contentType: 'text/plain',
            data: Buffer.from('plain words. '.repeat(300)),
          }),
          [415],
          'FILE_TYPE_REJECTED',
        ],
        [
          'text that claims to be a PDF',
          () => ({
            filename: 'fake.pdf',
            contentType: 'application/pdf',
            data: Buffer.from('not a pdf at all. '.repeat(300)),
          }),
          [415],
          'FILE_TYPE_REJECTED',
        ],
        ['an empty file', () => resumeFile('empty.pdf'), [400, 415, 422], null],
        [
          'a file of 5 MiB + 1 byte',
          () => ({
            filename: 'big.pdf',
            contentType: 'application/pdf',
            data: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(fiveMiB + 1 - 9, 0x20)]),
          }),
          [413],
          'FILE_TOO_LARGE',
        ],
        [
          'a form without the "file" field',
          () => resumeFile('resume.pdf', { field: 'attachment' }),
          [400],
          null,
        ],
      ];

      it.each(rejections)(
        'FR-PROF-02: %s is refused and no upload is created',
        async (_name, file, statuses, code) => {
          const user = await newUser('rej');
          const response = await upload(user, file());
          expect(statuses, `${response.statusCode}: ${response.body}`).toContain(
            response.statusCode,
          );
          expect(String(response.headers['content-type'])).toContain('application/problem+json');
          expectMatchesContract('uploadResume', response);
          if (code) expect(response.json<{ code: string }>().code).toBe(code);
          expect(await uploadCount(user.id)).toBe(0);
        },
      );

      it('FR-PROF-02: a JSON body instead of multipart -> 400 or 415, no upload is created', async () => {
        const user = await newUser('rej-json');
        const response = await world.as(user).post(RESUME_URL, { file: 'JVBERi0xLjQK' });
        expect([400, 415], response.body).toContain(response.statusCode);
        expectMatchesContract('uploadResume', response);
        expect(await uploadCount(user.id)).toBe(0);
      });

      it('FR-PROF-02: a file of exactly 5 MiB is not refused for its size', async () => {
        const user = await newUser('rej-edge');
        const data = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(fiveMiB - 9, 0x20)]);
        const response = await upload(user, {
          filename: 'edge.pdf',
          contentType: 'application/pdf',
          data,
        });
        expect(response.statusCode, response.body).not.toBe(413);
        if (response.statusCode === 202) await finalStatus(response.json<ResumeDto>().id);
      });
    });

    describe('uploadResume: hostile but well-formed files (FR-PROF-03)', () => {
      const hostile: [
        string,
        'pdf-bomb.pdf' | 'docx-bomb.docx' | 'encrypted.pdf',
        ParseResult,
        string | null,
      ][] = [
        [
          'a PDF with 400 pages',
          'pdf-bomb.pdf',
          { v: 1, ok: false, reason: 'LIMIT' },
          'limit_exceeded',
        ],
        [
          'a DOCX that expands to 60 MB',
          'docx-bomb.docx',
          { v: 1, ok: false, reason: 'LIMIT' },
          'limit_exceeded',
        ],
        ['an encrypted PDF', 'encrypted.pdf', { v: 1, ok: false, reason: 'ENCRYPTED' }, null],
      ];

      it.each(hostile)(
        'FR-PROF-03: %s is refused up front or ends as failed, and the next normal resume still gets parsed',
        async (_name, fixture, answer, reason) => {
          const user = await newUser('hostile');
          fake().respondWith(answer);
          const response = await upload(user, resumeFile(fixture));
          expect([202, 400, 413, 415, 422], response.body).toContain(response.statusCode);
          expectMatchesContract('uploadResume', response);
          if (response.statusCode === 202) {
            const { id } = response.json<ResumeDto>();
            expect(await finalStatus(id)).toBe('failed');
            const dto = await myResume(user);
            expect(dto.status).toBe('failed');
            if (reason) expect(dto.failureReason).toBe(reason);
            else expect(FAILURE_REASONS).toContain(dto.failureReason);
            expect(dto.extractedText ?? null).toBeNull();
            expect(dto.suggestions ?? null).toBeNull();
          } else {
            expect(['VALIDATION_FAILED', 'FILE_TOO_LARGE', 'FILE_TYPE_REJECTED']).toContain(
              response.json<{ code: string }>().code,
            );
            expect(await uploadCount(user.id)).toBe(0);
          }
          fake().respondWith(OK_ANSWER);
          const next = await uploaded(user);
          expect((await rowOf(next))?.status).toBe('done');
        },
      );
    });

    describe('parsing lifecycle with the resume-worker stand-in', () => {
      it('FR-PROF-03: queued -> done: the text the worker extracted is shown as plain text, processedAt is set', async () => {
        const user = await newUser('life');
        const response = await upload(user);
        expect(response.statusCode).toBe(202);
        const { id } = response.json<ResumeDto>();
        expect(response.json<ResumeDto>().status).toBe('queued');
        const dto = await waitFor<ResumeDto>(
          async () => {
            const current = await world.as(user).get(RESUME_URL);
            const body = current.json<ResumeDto>();
            return current.statusCode === 200 && body.status === 'done' ? body : false;
          },
          30_000,
          50,
        );
        expectMatchesContract('getMyResume', await world.as(user).get(RESUME_URL));
        expect(dto.id).toBe(id);
        expect(dto.extractedText).toBe(RESUME_TEXT);
        expect(dto.failureReason ?? null).toBeNull();
        expect(dto.processedAt).toBeTruthy();
        expect(fake().seen).toContain(id);
      });

      it('FR-PROF-04: the suggestions are a contract-shaped hint from the text and only name catalog tags', async () => {
        const user = await newUser('suggest');
        await uploaded(user);
        const dto = await myResume(user);
        expect(dto.suggestions).not.toBeNull();
        const stack = (dto.suggestions as { stack?: string[] }).stack ?? [];
        expect(stack).toEqual(expect.arrayContaining(['typescript', 'postgresql']));
        const known = await world.sql<{ code: string }[]>`
        SELECT code FROM profiles.stack_tag WHERE code IN ${world.sql(stack)}`;
        expect(known).toHaveLength(stack.length);
      });

      it('FR-PROF-04: suggestions change nothing in the profile until the user confirms: still no profile', async () => {
        const user = await newUser('suggest-only');
        await uploaded(user);
        expectProblem('getMyProfile', await world.as(user).get(PROFILE_URL), 404, 'NOT_FOUND');
      });

      it.each([
        ['NO_TEXT', 'scan_without_text'],
        ['TIMEOUT', 'timeout'],
        ['LIMIT', 'limit_exceeded'],
        ['CORRUPTED', 'corrupted'],
        ['ENCRYPTED', null],
        ['UNSUPPORTED', null],
      ] as const)(
        'FR-PROF-03: the worker answer %s ends as failed with a reason from the contract',
        async (reason, expected) => {
          const user = await newUser('fail');
          fake().respondWith({ v: 1, ok: false, reason });
          const id = await uploaded(user);
          const dto = await myResume(user);
          expect(dto.id).toBe(id);
          expect(dto.status).toBe('failed');
          if (expected) expect(dto.failureReason).toBe(expected);
          else expect(FAILURE_REASONS).toContain(dto.failureReason);
          expect(dto.extractedText ?? null).toBeNull();
          expect(dto.suggestions ?? null).toBeNull();
          expect(dto.processedAt).toBeTruthy();
        },
      );

      it('FR-PROF-03: a scan without text leaves the form empty: failed, no text, no suggestions, and the profile is untouched', async () => {
        const user = await newUser('scan');
        await insertProfile(world.sql, user.id);
        fake().respondWith({ v: 1, ok: false, reason: 'NO_TEXT' });
        await uploaded(user, resumeFile('no-text.pdf'));
        const dto = await myResume(user);
        expect(dto).toMatchObject({ status: 'failed', failureReason: 'scan_without_text' });
        const profile = (await world.as(user).get(PROFILE_URL)).json<ProfileDto>();
        expect(profile.version).toBe(1);
      });

      it.each([
        ['an extra field', { v: 1, ok: true, text: 'abc', pages: 1, extra: true }],
        ['a NUL byte in the text', { v: 1, ok: true, text: 'abc\u0000def', pages: 1 }],
        ['a control character in the text', { v: 1, ok: true, text: 'abc\u0007def', pages: 1 }],
        ['a text of 100001 characters', { v: 1, ok: true, text: 'a'.repeat(100_001), pages: 1 }],
        ['a wrong protocol version', { v: 2, ok: true, text: 'abc', pages: 1 }],
        ['no page count', { v: 1, ok: true, text: 'abc' }],
        ['31 pages', { v: 1, ok: true, text: 'abc', pages: 31 }],
        ['an unknown failure reason', { v: 1, ok: false, reason: 'EXPLODED' }],
        ['a flag that is not a boolean', { v: 1, ok: 'yes', text: 'abc', pages: 1 }],
      ] as [string, ParseResult][])(
        'FR-PROF-03: a malformed worker answer (%s) ends as failed, never as done',
        async (_name, answer) => {
          const user = await newUser('malformed');
          fake().respondWith(answer);
          const id = await uploaded(user);
          const row = await rowOf(id);
          expect(row?.status).toBe('failed');
          expect(row?.extracted_text).toBeNull();
          const dto = await myResume(user);
          expect(dto.status).toBe('failed');
          expect(FAILURE_REASONS).toContain(dto.failureReason);
          expect(dto.extractedText ?? null).toBeNull();
        },
      );

      it('FR-PROF-03: a text of exactly 100000 characters with line breaks and tabs is accepted as done', async () => {
        const user = await newUser('big-text');
        const head = 'Строка один\n\tСтрока два\n';
        const text = head + 'я'.repeat(100_000 - head.length);
        expect(text).toHaveLength(100_000);
        fake().respondWith({ v: 1, ok: true, text, pages: 30 });
        await uploaded(user);
        const dto = await myResume(user);
        expect(dto.status).toBe('done');
        expect(dto.extractedText).toBe(text);
      });
    });

    describe('getMyResume', () => {
      it('FR-PROF-03: before any upload -> 404 NOT_FOUND', async () => {
        const user = await newUser('get-none');
        expectProblem('getMyResume', await world.as(user).get(RESUME_URL), 404, 'NOT_FOUND');
      });

      it('FR-PROF-03: after uploads it returns the latest one, with its own text', async () => {
        const user = await newUser('get-latest');
        fake().respondWith((uploadId) => ({
          v: 1,
          ok: true,
          text: `Резюме ${uploadId}`,
          pages: 1,
        }));
        const first = await uploaded(user);
        const second = await uploaded(user);
        const dto = await myResume(user);
        expect(dto.id).toBe(second);
        expect(dto.id).not.toBe(first);
        expect(dto.extractedText).toBe(`Резюме ${second}`);
      });

      it("FR-PROF-03: other users' uploads are never returned", async () => {
        const [owner, other, nobody] = [
          await newUser('get-a'),
          await newUser('get-b'),
          await newUser('get-c'),
        ] as [UserFixture, UserFixture, UserFixture];
        const ownerId = await uploaded(owner);
        const otherId = await uploaded(other);
        expect((await myResume(owner)).id).toBe(ownerId);
        expect((await myResume(other)).id).toBe(otherId);
        expectProblem('getMyResume', await world.as(nobody).get(RESUME_URL), 404, 'NOT_FOUND');
      });
    });

    describe('limits and idempotency of uploadResume', () => {
      it('FR-AUTH-04: five uploads per hour are accepted, the sixth -> 429 RATE_LIMITED with Retry-After; another user is unaffected', async () => {
        const user = await newUser('rate');
        for (let i = 1; i <= 5; i += 1) {
          const accepted = await upload(user);
          expect(accepted.statusCode, `upload ${i}: ${accepted.body}`).toBe(202);
        }
        expectRateLimited('uploadResume', await upload(user));
        expect(await uploadCount(user.id)).toBe(5);
        const other = await newUser('rate-other');
        const response = await upload(other);
        expect(response.statusCode, response.body).toBe(202);
        await settleUsers([user.id, other.id]);
      });

      it('FR-WORK-08: the same Idempotency-Key and the same bytes replay the stored 202: one upload, one object', async () => {
        const user = await newUser('up-replay');
        const key = randomUUID();
        const first = await upload(user, resumeFile('resume.pdf'), key);
        const second = await upload(user, resumeFile('resume.pdf'), key);
        expect(first.statusCode, first.body).toBe(202);
        expect(second.statusCode, second.body).toBe(202);
        expectReplayed(second);
        expectMatchesContract('uploadResume', second);
        expect(second.json<ResumeDto>().id).toBe(first.json<ResumeDto>().id);
        expect(await uploadCount(user.id)).toBe(1);
        await finalStatus(first.json<ResumeDto>().id);
      });

      it('FR-WORK-08: the same Idempotency-Key with other bytes -> 422 IDEMPOTENCY_KEY_REUSED', async () => {
        const user = await newUser('up-reused');
        const key = randomUUID();
        const first = await upload(user, resumeFile('resume.pdf'), key);
        expect(first.statusCode).toBe(202);
        const second = await upload(user, resumeFile('resume.docx'), key);
        expectProblem('uploadResume', second, 422, 'IDEMPOTENCY_KEY_REUSED');
        expect(await uploadCount(user.id)).toBe(1);
        await finalStatus(first.json<ResumeDto>().id);
      });

      it('FR-WORK-08: without an Idempotency-Key -> 400 IDEMPOTENCY_KEY_MISSING', async () => {
        const user = await newUser('up-nokey');
        const response = await world
          .as(user)
          .upload(RESUME_URL, resumeFile('resume.pdf'), { idempotencyKey: null });
        expectProblem('uploadResume', response, 400, 'IDEMPOTENCY_KEY_MISSING');
        expect(await uploadCount(user.id)).toBe(0);
      });
    });

    describe('access and privacy', () => {
      const operations = [
        'uploadResume',
        'getMyResume',
        'confirmResumeFields',
        'deleteResume',
      ] as const;

      it.each(operations)(
        'FR-PROF-02: %s without a session -> 401 UNAUTHENTICATED',
        async (operationId) => {
          const request = requestFor(operationId, { uploadId: randomUUID() });
          expectProblem(
            operationId,
            await send(world.anonymous(), request),
            401,
            'UNAUTHENTICATED',
          );
        },
      );

      it.each(operations)(
        'FR-AUTH-03: %s without consent -> 403 CONSENT_REQUIRED',
        async (operationId) => {
          const user = await newUser('res-noconsent', { consent: false });
          const request = requestFor(operationId, { uploadId: randomUUID() });
          expectProblem(operationId, await send(world.as(user), request), 403, 'CONSENT_REQUIRED');
          expect(await uploadCount(user.id)).toBe(0);
        },
      );

      it('FR-PROF-03: the resume text never reaches the application log', async () => {
        const user = await newUser('privacy');
        await insertProfile(world.sql, user.id);
        const marker = `ZQ${hex(16)}-private-resume-line`;
        fake().respondWith({ v: 1, ok: true, text: `${marker} Python Django`, pages: 1 });
        const id = await uploaded(user);
        expect((await myResume(user)).extractedText).toContain(marker);
        const confirm = await world.as(user).post(confirmUrl(id), {
          confirmedFields: { stack: ['typescript'] },
          keepFile: true,
          profileVersion: 1,
        });
        expect(confirm.statusCode, confirm.body).toBe(200);
        expect(logLinesWith(world.logs, marker)).toEqual([]);
      });
    });
  },
);
