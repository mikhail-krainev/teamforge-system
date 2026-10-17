import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALLOWED_FORMATS,
  KIB,
  MIB,
  OVER_MAX_BYTES,
  PROJECT_MAX_BYTES,
  PROJECT_MAX_FILES,
  exeFile,
  hugeFile,
  pdfFile,
  pngFile,
  renamedTextFile,
  tinyFile,
} from '../../../../test/fixtures/artifact-files.js';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import { resumeFile } from '../../../../test/fixtures/profiles.js';
import { expectOk, githubUser } from '../../../../test/fixtures/teams.js';
import {
  doneWithFile,
  itemOf,
  patchItem,
  routeTeam,
  uploadFile,
  type ArtifactFileDto,
  type ChecklistItemDto,
  type RouteFixture,
} from '../../../../test/fixtures/workspace.js';
import {
  activeFilesOfTeam,
  fileRows,
  itemRow,
  setUsage,
  usageOf,
} from '../../../../test/fixtures/workspace-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

/*
 * S5-01 for S5-06: uploadArtifactFile, getArtifactDownloadUrl, deleteArtifactFile (FR-WORK-05, FR-AUTH-04,
 * FR-PLAY-08). Quota C-48/C-49 is a conditional UPDATE of project_storage_usage (architecture 12.3);
 * the item is locked (#9) and its version grows with every upload and deletion.
 */

describeInfra('S5 workspace: artifact files (FR-WORK-05)', ['db', 'redis', 's3'], () => {
  let world: World;
  const clock = new FakeClock(Date.now());

  beforeAll(async () => {
    world = await startWorld({ clock });
  });

  afterAll(async () => {
    if (!world) return;
    await world.close();
  });

  const url = (t: RouteFixture, item: { id: string }, suffix = ''): string =>
    `/v1/teams/${t.team.id}/checklist-items/${item.id}/files${suffix}`;

  /** The step that takes files, executed by the backend member. */
  const specOf = (t: RouteFixture): Promise<ChecklistItemDto> => itemOf(t, 'mini_spec');

  describe('uploadArtifactFile', () => {
    it.each(ALLOWED_FORMATS)(
      'FR-WORK-05: a %s file is accepted -> 201 ArtifactFile; the item version grows, the quota counts it',
      async (_format, build) => {
        const t = await routeTeam(world);
        const item = await specOf(t);
        const file = build();
        const response = await uploadFile(world, t.backend, t.team.id, item.id, file);
        const stored = expectOk<ArtifactFileDto>('uploadArtifactFile', response, 201);
        expect(stored).toMatchObject({
          originalName: file.filename,
          sizeBytes: file.data.length,
          uploadedBy: t.backend.id,
          sha256: createHash('sha256').update(file.data).digest('hex'),
        });
        expect(stored.mime.length).toBeGreaterThan(0);
        expect((await itemOf(t, 'mini_spec')).version).toBe(item.version + 1);
        expect((await itemOf(t, 'mini_spec')).files.map((f) => f.id)).toEqual([stored.id]);
        expect(await usageOf(world, t.team.id)).toEqual({ files: 1, bytes: file.data.length });
      },
    );

    it('FR-WORK-05: the type comes from the magic bytes, not from the name or Content-Type: the mime of a PNG named .pdf is image/png', async () => {
      const t = await routeTeam(world);
      const item = await specOf(t);
      const png = { ...pngFile(), filename: 'looks-like.pdf', contentType: 'application/pdf' };
      const stored = expectOk<ArtifactFileDto>(
        'uploadArtifactFile',
        await uploadFile(world, t.backend, t.team.id, item.id, png),
        201,
      );
      expect(stored.mime).toBe('image/png');
    });

    it('FR-WORK-05: the file is kept in the artifacts bucket under a random key (no user name in it), the name only in the row', async () => {
      const t = await routeTeam(world);
      const item = await specOf(t);
      const file = { ...pdfFile(), filename: '../../etc/passwd.pdf' };
      expectOk(
        'uploadArtifactFile',
        await uploadFile(world, t.backend, t.team.id, item.id, file),
        201,
      );
      const [row] = await fileRows(world, item.id);
      expect(row?.storage_key).toBeDefined();
      expect(row?.storage_key).not.toContain('passwd');
      expect(row?.storage_key).not.toContain('..');
      expect(row?.original_name).not.toContain('/');
    });

    it.each([
      ['an executable behind a .pdf name', () => exeFile()],
      [
        'an executable with an honest name and type',
        () => exeFile({ name: 'setup.exe', contentType: 'application/octet-stream' }),
      ],
      ['text that claims to be a PDF', () => renamedTextFile()],
    ])(
      'FR-WORK-05: %s -> 415 FILE_TYPE_REJECTED; no row, no quota, the item version is unchanged',
      async (_title, build) => {
        const t = await routeTeam(world);
        const item = await specOf(t);
        expectProblem(
          'uploadArtifactFile',
          await uploadFile(world, t.backend, t.team.id, item.id, build()),
          415,
          'FILE_TYPE_REJECTED',
        );
        expect(await fileRows(world, item.id)).toEqual([]);
        expect(await usageOf(world, t.team.id)).toEqual({ files: 0, bytes: 0 });
        expect((await itemRow(world, item.id)).version).toBe(item.version);
      },
    );

    it('FR-WORK-05: a file under 1 KiB -> 422 FILE_TOO_SMALL', async () => {
      const t = await routeTeam(world);
      const item = await specOf(t);
      expectProblem(
        'uploadArtifactFile',
        await uploadFile(world, t.backend, t.team.id, item.id, tinyFile()),
        422,
        'FILE_TOO_SMALL',
      );
      expect(await usageOf(world, t.team.id)).toEqual({ files: 0, bytes: 0 });
    });

    it('FR-WORK-05: a file over 10 MB (one byte over 10 MiB) -> 413 FILE_TOO_LARGE; far over (11 MiB, refused by the gate) -> 413 as well', async () => {
      const t = await routeTeam(world);
      const item = await specOf(t);
      expectProblem(
        'uploadArtifactFile',
        await uploadFile(world, t.backend, t.team.id, item.id, hugeFile(OVER_MAX_BYTES)),
        413,
        'FILE_TOO_LARGE',
      );
      expectProblem(
        'uploadArtifactFile',
        await uploadFile(world, t.backend, t.team.id, item.id, hugeFile(11 * MIB)),
        413,
        'FILE_TOO_LARGE',
      );
      expect(await fileRows(world, item.id)).toEqual([]);
      expect(await usageOf(world, t.team.id)).toEqual({ files: 0, bytes: 0 });
    });

    it('FR-WORK-05: a zip bomb (a DOCX that expands past the limit) is refused and stores nothing', async () => {
      const t = await routeTeam(world);
      const item = await specOf(t);
      const bomb = resumeFile('docx-bomb.docx');
      const response = await uploadFile(world, t.backend, t.team.id, item.id, bomb);
      expect([413, 415, 422]).toContain(response.statusCode);
      expect(await fileRows(world, item.id)).toEqual([]);
    });

    it('FR-WORK-05: a request without the file part -> 400', async () => {
      const t = await routeTeam(world);
      const item = await specOf(t);
      const response = await world
        .as(t.backend)
        .upload(url(t, item), { ...pdfFile(), field: 'attachment' });
      expect(response.statusCode, response.body).toBe(400);
    });

    it('FR-WORK-05: only an open item takes files: a done item -> 409 INVALID_STATE', async () => {
      const t = await routeTeam(world);
      const done = await doneWithFile(t, 'mini_spec', t.backend);
      expect(done.status).toBe('done');
      expectProblem(
        'uploadArtifactFile',
        await uploadFile(world, t.backend, t.team.id, done.id),
        409,
        'INVALID_STATE',
      );
      expect(await activeFilesOfTeam(world, t.team.id)).toBe(1);
    });

    it('FR-WORK-05: an item that takes a link only (submission link) or is a ritual does not take files', async () => {
      const t = await routeTeam(world);
      const board = await itemOf(t, 'mini_board');
      const kickoff = await itemOf(t, 'mini_kickoff');
      for (const item of [board, kickoff]) {
        const response = await uploadFile(world, t.backend, t.team.id, item.id);
        expect([409, 415, 422], `${item.stepKey}: ${response.body}`).toContain(response.statusCode);
      }
      expect(await activeFilesOfTeam(world, t.team.id)).toBe(0);
    });

    it('FR-WORK-07: an upload raises the version, so a PATCH written with the old version gets 409 VERSION_CONFLICT', async () => {
      const t = await routeTeam(world);
      const item = await specOf(t);
      expectOk('uploadArtifactFile', await uploadFile(world, t.backend, t.team.id, item.id), 201);
      const stale = await patchItem(world, t.backend, t.team.id, item.id, {
        version: item.version,
        status: 'done',
      });
      expectProblem('updateChecklistItem', stale, 409, 'VERSION_CONFLICT');
    });

    it('FR-WORK-08: the same Idempotency-Key repeats the stored 201 and stores one file', async () => {
      const t = await routeTeam(world);
      const item = await specOf(t);
      const key = randomUUID();
      const file = pdfFile();
      const first = await uploadFile(world, t.backend, t.team.id, item.id, file, { key });
      expectOk('uploadArtifactFile', first, 201);
      const replay = await uploadFile(world, t.backend, t.team.id, item.id, file, { key });
      expect(replay.statusCode).toBe(201);
      expectReplayed(replay);
      expect(await fileRows(world, item.id)).toHaveLength(1);
      expect(await usageOf(world, t.team.id)).toEqual({ files: 1, bytes: file.data.length });
    });

    it('FR-WORK-05: a member of another team gets 404 and nothing is stored', async () => {
      const t = await routeTeam(world);
      const other = await routeTeam(world);
      const item = await specOf(t);
      expectProblem(
        'uploadArtifactFile',
        await uploadFile(world, other.backend, t.team.id, item.id),
        404,
        'NOT_FOUND',
      );
      expect(await fileRows(world, item.id)).toEqual([]);
    });

    it('FR-PLAY-08: the same bytes in two projects are two accepted files (sha_dedup is a signal, not a block)', async () => {
      const a = await routeTeam(world);
      const b = await routeTeam(world);
      const file = pdfFile();
      expectOk(
        'uploadArtifactFile',
        await uploadFile(world, a.backend, a.team.id, (await specOf(a)).id, file),
        201,
      );
      expectOk(
        'uploadArtifactFile',
        await uploadFile(world, b.backend, b.team.id, (await specOf(b)).id, file),
        201,
      );
    });
  });

  describe('the project quota: 30 files and 50 MB (C-48, C-49)', () => {
    it('FR-WORK-05: the 31st file -> 409 PROJECT_STORAGE_LIMIT; nothing stored, counters and item unchanged', async () => {
      const t = await routeTeam(world);
      const item = await specOf(t);
      await setUsage(world, t.team.id, { files: PROJECT_MAX_FILES, bytes: 30 * KIB });
      expectProblem(
        'uploadArtifactFile',
        await uploadFile(world, t.backend, t.team.id, item.id),
        409,
        'PROJECT_STORAGE_LIMIT',
      );
      expect(await usageOf(world, t.team.id)).toEqual({
        files: PROJECT_MAX_FILES,
        bytes: 30 * KIB,
      });
      expect(await fileRows(world, item.id)).toEqual([]);
      expect((await itemRow(world, item.id)).version).toBe(item.version);
    });

    it('FR-WORK-05: a file that does not fit in the remaining bytes -> 409 PROJECT_STORAGE_LIMIT; one that fits exactly is accepted', async () => {
      const t = await routeTeam(world);
      const item = await specOf(t);
      const file = pdfFile({ size: 4 * KIB });
      await setUsage(world, t.team.id, {
        files: 5,
        bytes: PROJECT_MAX_BYTES - file.data.length + 1,
      });
      expectProblem(
        'uploadArtifactFile',
        await uploadFile(world, t.backend, t.team.id, item.id, file),
        409,
        'PROJECT_STORAGE_LIMIT',
      );
      await setUsage(world, t.team.id, { files: 5, bytes: PROJECT_MAX_BYTES - file.data.length });
      expectOk(
        'uploadArtifactFile',
        await uploadFile(world, t.backend, t.team.id, item.id, file),
        201,
      );
      expect(await usageOf(world, t.team.id)).toEqual({ files: 6, bytes: PROJECT_MAX_BYTES });
    });

    it('FR-WORK-05: a rejected upload gives the quota back: after a 415 at 29 files the next valid file is accepted (the 30th)', async () => {
      const t = await routeTeam(world);
      const item = await specOf(t);
      await setUsage(world, t.team.id, { files: PROJECT_MAX_FILES - 1, bytes: 29 * KIB });
      expectProblem(
        'uploadArtifactFile',
        await uploadFile(world, t.backend, t.team.id, item.id, exeFile()),
        415,
        'FILE_TYPE_REJECTED',
      );
      expect((await usageOf(world, t.team.id)).files).toBe(PROJECT_MAX_FILES - 1);
      expectOk('uploadArtifactFile', await uploadFile(world, t.backend, t.team.id, item.id), 201);
      expect((await usageOf(world, t.team.id)).files).toBe(PROJECT_MAX_FILES);
    });

    it('FR-WORK-05: the quota belongs to the project: a full project does not block another one', async () => {
      const full = await routeTeam(world);
      const free = await routeTeam(world);
      await setUsage(world, full.team.id, { files: PROJECT_MAX_FILES, bytes: PROJECT_MAX_BYTES });
      expectOk(
        'uploadArtifactFile',
        await uploadFile(world, free.backend, free.team.id, (await specOf(free)).id),
        201,
      );
    });
  });

  describe('deleteArtifactFile', () => {
    const uploaded = async (
      t: RouteFixture,
    ): Promise<{ item: ChecklistItemDto; file: ArtifactFileDto }> => {
      const item = await specOf(t);
      const file = expectOk<ArtifactFileDto>(
        'uploadArtifactFile',
        await uploadFile(world, t.backend, t.team.id, item.id),
        201,
      );
      return { item, file };
    };

    it('FR-WORK-05: the author deletes his file -> 204; the quota is given back, the item version grows, the file leaves the list', async () => {
      const t = await routeTeam(world);
      const { item, file } = await uploaded(t);
      const before = await itemOf(t, 'mini_spec');
      const response = await world.as(t.backend).delete(url(t, item, `/${file.id}`));
      expect(response.statusCode, response.body).toBe(204);
      expect(await usageOf(world, t.team.id)).toEqual({ files: 0, bytes: 0 });
      const after = await itemOf(t, 'mini_spec');
      expect(after.files).toEqual([]);
      expect(after.version).toBe(before.version + 1);
      expect(item.id).toBe(after.id);
    });

    it('FR-WORK-05: the lead may delete a file of a member; a repeated delete -> 404', async () => {
      const t = await routeTeam(world);
      const { item, file } = await uploaded(t);
      expect((await world.as(t.lead).delete(url(t, item, `/${file.id}`))).statusCode).toBe(204);
      expectProblem(
        'deleteArtifactFile',
        await world.as(t.lead).delete(url(t, item, `/${file.id}`)),
        404,
        'NOT_FOUND',
      );
    });

    it('FR-WORK-05: a member who is neither the author nor the lead -> 403, the file stays', async () => {
      const t = await routeTeam(world);
      const { item, file } = await uploaded(t);
      const response = await world.as(t.frontend).delete(url(t, item, `/${file.id}`));
      expect(response.statusCode, response.body).toBe(403);
      expect(String(response.headers['content-type'])).toContain('application/problem+json');
      expect(await fileRows(world, item.id)).toHaveLength(1);
      expect(await usageOf(world, t.team.id).then((u) => u.files)).toBe(1);
    });

    it('FR-WORK-05: a file of a done item cannot be deleted -> 409 INVALID_STATE (the result stays as it was submitted)', async () => {
      const t = await routeTeam(world);
      const done = await doneWithFile(t, 'mini_spec', t.backend);
      const file = done.files[0];
      if (!file) throw new Error('no file');
      expectProblem(
        'deleteArtifactFile',
        await world.as(t.backend).delete(url(t, done, `/${file.id}`)),
        409,
        'INVALID_STATE',
      );
      expect(await usageOf(world, t.team.id).then((u) => u.files)).toBe(1);
    });
  });

  describe('getArtifactDownloadUrl', () => {
    it('FR-WORK-05: a member gets a short-lived signed link on the separate files origin (not the application origin)', async () => {
      const t = await routeTeam(world);
      const item = await specOf(t);
      const file = expectOk<ArtifactFileDto>(
        'uploadArtifactFile',
        await uploadFile(world, t.backend, t.team.id, item.id),
        201,
      );
      const response = await world.as(t.frontend).get(url(t, item, `/${file.id}/download-url`));
      const link = expectOk<{ url: string; expiresAt: string }>(
        'getArtifactDownloadUrl',
        response,
        200,
      );
      const parsed = new URL(link.url);
      expect(parsed.origin).not.toBe(new URL(world.origin).origin);
      const ttlMs = Date.parse(link.expiresAt) - Date.now();
      expect(ttlMs).toBeGreaterThan(0);
      expect(ttlMs).toBeLessThanOrEqual(5 * 60_000 + 5_000);
      expect(link.url).not.toContain(t.backend.id);
    });

    it('FR-WORK-05: a deleted file, an unknown file and a file of another item -> 404', async () => {
      const t = await routeTeam(world);
      const item = await specOf(t);
      const file = expectOk<ArtifactFileDto>(
        'uploadArtifactFile',
        await uploadFile(world, t.backend, t.team.id, item.id),
        201,
      );
      const board = await itemOf(t, 'mini_board');
      expectProblem(
        'getArtifactDownloadUrl',
        await world.as(t.lead).get(url(t, board, `/${file.id}/download-url`)),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        'getArtifactDownloadUrl',
        await world.as(t.lead).get(url(t, item, `/${randomUUID()}/download-url`)),
        404,
        'NOT_FOUND',
      );
      await world.as(t.backend).delete(url(t, item, `/${file.id}`));
      expectProblem(
        'getArtifactDownloadUrl',
        await world.as(t.lead).get(url(t, item, `/${file.id}/download-url`)),
        404,
        'NOT_FOUND',
      );
    });

    it('FR-WORK-05: a person outside the team gets 404 for the link', async () => {
      const t = await routeTeam(world);
      const item = await specOf(t);
      const file = expectOk<ArtifactFileDto>(
        'uploadArtifactFile',
        await uploadFile(world, t.backend, t.team.id, item.id),
        201,
      );
      const stranger = await githubUser(world, 'download-stranger');
      expectProblem(
        'getArtifactDownloadUrl',
        await world.as(stranger).get(url(t, item, `/${file.id}/download-url`)),
        404,
        'NOT_FOUND',
      );
    });
  });
});
