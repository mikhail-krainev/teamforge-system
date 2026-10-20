import { afterAll, beforeAll, expect, it } from 'vitest';
import { KIB, PROJECT_MAX_BYTES, PROJECT_MAX_FILES, pdfFile } from '../fixtures/artifact-files.js';
import { codesAt, expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import { expectOk } from '../fixtures/teams.js';
import { expectNoDeadlocks } from '../fixtures/teams-db.js';
import {
  doneWithFile,
  itemOf,
  patchItem,
  routeTeam,
  startRouteWorld,
  uploadFile,
  type ArtifactFileDto,
} from '../fixtures/workspace.js';
import {
  activeFilesOfTeam,
  fileRows,
  itemRow,
  setUsage,
  usageOf,
} from '../fixtures/workspace-db.js';
import type { World } from '../fixtures/world.js';
import { describeInfra } from '../helpers/infra.js';

/*
 * Races of files and quotas (docs/architecture.md 12.3, plan "Тесты среза"):
 *  - the quota C-48/C-49 is a conditional UPDATE of project_storage_usage;
 *  - an upload, a deletion and `PATCH status=done` all lock the item (#9) after the stage (#8) and
 *    raise its version, so the pair has exactly one outcome.
 * Run with `--repeat 5` (plan, S5 criteria).
 */
describeInfra('Files: quota and item races (FR-WORK-05, FR-WORK-07)', ['db', 'redis', 's3'], () => {
  let world: World;
  let deadlocksBefore = 0;

  beforeAll(async () => {
    world = await startRouteWorld();
    deadlocksBefore = await world.deadlocks();
  });

  afterAll(async () => {
    if (!world) return;
    await expectNoDeadlocks(world, deadlocksBefore);
    expect(world.logs.filter((line) => line.includes('40P01'))).toEqual([]);
    await world.close();
  });

  it('20 parallel uploads with room for ONE more file -> 1 x 201, 19 x 409 PROJECT_STORAGE_LIMIT; the counters stay within the limits', async () => {
    const t = await routeTeam(world);
    const item = await itemOf(t, 'mini_spec');
    await setUsage(world, t.team.id, { files: PROJECT_MAX_FILES - 1, bytes: 29 * KIB });
    const fired = await fireAll(20, (_i, key) =>
      uploadFile(world, t.backend, t.team.id, item.id, pdfFile(), { key }),
    );
    expect(tally(fired)).toEqual({ 201: 1, 409: 19 });
    expect(codesAt(fired, 409)).toEqual(['PROJECT_STORAGE_LIMIT']);
    const usage = await usageOf(world, t.team.id);
    expect(usage.files).toBe(PROJECT_MAX_FILES);
    expect(usage.bytes).toBeLessThanOrEqual(PROJECT_MAX_BYTES);
    expect(await fileRows(world, item.id)).toHaveLength(1);
    expect((await itemRow(world, item.id)).version).toBe(item.version + 1);
  });

  it('20 parallel uploads from 4 people into 4 different items, room for ONE more file -> still exactly 1 success (the quota is per project, not per item)', async () => {
    const t = await routeTeam(world);
    const items = [
      await itemOf(t, 'mini_spec'),
      await itemOf(t, 'mini_charter'),
      await itemOf(t, 'mini_optional'),
      await itemOf(t, 'mini_spec'),
    ];
    const people = [t.backend, t.frontend, t.lead, t.backend];
    await setUsage(world, t.team.id, { files: PROJECT_MAX_FILES - 1, bytes: 29 * KIB });
    const fired = await fireAll(20, (i, key) => {
      const target = items[i % items.length];
      const person = people[i % people.length];
      if (!target || !person) throw new Error('fixture');
      return uploadFile(world, person, t.team.id, target.id, pdfFile(), { key });
    });
    expect(tally(fired)).toEqual({ 201: 1, 409: 19 });
    expect((await usageOf(world, t.team.id)).files).toBe(PROJECT_MAX_FILES);
    expect(await activeFilesOfTeam(world, t.team.id)).toBe(1);
  });

  it('20 parallel uploads when only the BYTES run out (room for one file of 4 KiB, not for two) -> 1 success, bytes_total <= 50 MiB', async () => {
    const t = await routeTeam(world);
    const item = await itemOf(t, 'mini_spec');
    const size = 4 * KIB;
    await setUsage(world, t.team.id, { files: 3, bytes: PROJECT_MAX_BYTES - size - size / 2 });
    const fired = await fireAll(20, (_i, key) =>
      uploadFile(world, t.backend, t.team.id, item.id, pdfFile({ size }), { key }),
    );
    expect(tally(fired)).toEqual({ 201: 1, 409: 19 });
    expect(codesAt(fired, 409)).toEqual(['PROJECT_STORAGE_LIMIT']);
    expect((await usageOf(world, t.team.id)).bytes).toBeLessThanOrEqual(PROJECT_MAX_BYTES);
  });

  it('(paired) the winning upload repeated with its key returns the stored 201 and takes no second slot', async () => {
    const t = await routeTeam(world);
    const item = await itemOf(t, 'mini_spec');
    await setUsage(world, t.team.id, { files: PROJECT_MAX_FILES - 1, bytes: 29 * KIB });
    const file = pdfFile();
    const fired = await fireAll(5, (_i, key) =>
      uploadFile(world, t.backend, t.team.id, item.id, file, { key }),
    );
    const winner = winnerOf(fired, 201);
    expectReplayOf(
      winner,
      await uploadFile(world, t.backend, t.team.id, item.id, file, { key: winner.key }),
    );
    expect((await usageOf(world, t.team.id)).files).toBe(PROJECT_MAX_FILES);
  });

  it('C-34: 35 parallel uploads of one person (30 per hour) -> 30 x 201, 5 x 429 RATE_LIMITED; the quota counts only the 30 accepted', async () => {
    const t = await routeTeam(world);
    const item = await itemOf(t, 'mini_spec');
    const fired = await fireAll(35, (_i, key) =>
      uploadFile(world, t.backend, t.team.id, item.id, pdfFile(), { key }),
    );
    expect(tally(fired)).toEqual({ 201: 30, 429: 5 });
    for (const f of fired.filter((x) => x.status === 429)) {
      expect(Number(f.response.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    }
    expect((await usageOf(world, t.team.id)).files).toBe(30);
    expect(await fileRows(world, item.id)).toHaveLength(30);
  });

  it('10 parallel deletions of one file -> 1 x 204, 9 x 404; the quota is given back once (never below zero)', async () => {
    const t = await routeTeam(world);
    const item = await itemOf(t, 'mini_spec');
    const file = expectOk<ArtifactFileDto>(
      'uploadArtifactFile',
      await uploadFile(world, t.backend, t.team.id, item.id),
      201,
    );
    const fired = await fireAll(10, (_i, key) =>
      world
        .as(t.backend)
        .delete(`/v1/teams/${t.team.id}/checklist-items/${item.id}/files/${file.id}`, {
          idempotencyKey: key,
        }),
    );
    expect(tally(fired)).toEqual({ 204: 1, 404: 9 });
    expect(await usageOf(world, t.team.id)).toEqual({ files: 0, bytes: 0 });
  });

  it('upload against `PATCH status=done` (both with version N): exactly one wins; the item is never done with a file added after it was closed', async () => {
    for (let round = 0; round < 5; round += 1) {
      const t = await routeTeam(world);
      const first = await itemOf(t, 'mini_spec');
      expectOk('uploadArtifactFile', await uploadFile(world, t.backend, t.team.id, first.id), 201);
      const item = await itemOf(t, 'mini_spec');
      const fired = await fireAll(2, (i, key) =>
        i === 0
          ? uploadFile(world, t.backend, t.team.id, item.id, pdfFile(), { key })
          : patchItem(
              world,
              t.backend,
              t.team.id,
              item.id,
              { version: item.version, status: 'done' },
              { key },
            ),
      );
      const [upload, done] = fired;
      const stored = await itemRow(world, item.id);
      const files = await fileRows(world, item.id);
      expect(stored.version).toBe(item.version + 1);
      if (upload?.status === 201) {
        expect(done?.status).toBe(409);
        expect(done?.code).toBe('VERSION_CONFLICT');
        expect(stored.status).toBe('open');
        expect(files).toHaveLength(2);
      } else {
        expect(done?.status).toBe(200);
        expect(upload?.status).toBe(409);
        expect(upload?.code).toBe('INVALID_STATE');
        expect(stored.status).toBe('done');
        expect(files).toHaveLength(1);
      }
      expect(await usageOf(world, t.team.id).then((u) => u.files)).toBe(files.length);
    }
  });

  it('deletion of the only file against `PATCH status=done`: an item is never done without a file', async () => {
    for (let round = 0; round < 5; round += 1) {
      const t = await routeTeam(world);
      const first = await itemOf(t, 'mini_spec');
      const file = expectOk<ArtifactFileDto>(
        'uploadArtifactFile',
        await uploadFile(world, t.backend, t.team.id, first.id),
        201,
      );
      const item = await itemOf(t, 'mini_spec');
      const fired = await fireAll(2, (i, key) =>
        i === 0
          ? world
              .as(t.lead)
              .delete(`/v1/teams/${t.team.id}/checklist-items/${item.id}/files/${file.id}`, {
                idempotencyKey: key,
              })
          : patchItem(
              world,
              t.backend,
              t.team.id,
              item.id,
              { version: item.version, status: 'done' },
              { key },
            ),
      );
      const [deletion, done] = fired;
      const stored = await itemRow(world, item.id);
      const files = await fileRows(world, item.id);
      expect(
        [deletion?.status, done?.status].filter((s) => s !== undefined && s < 300),
      ).toHaveLength(1);
      if (stored.status === 'done') expect(files).toHaveLength(1);
      expect(stored.status === 'done' && files.length === 0).toBe(false);
      expect(stored.version).toBe(item.version + 1);
    }
  });

  it('a file cannot be added to an item that is already done, however the requests are ordered', async () => {
    const t = await routeTeam(world);
    const done = await doneWithFile(t, 'mini_spec', t.backend);
    const fired = await fireAll(10, (_i, key) =>
      uploadFile(world, t.backend, t.team.id, done.id, pdfFile(), { key }),
    );
    expect(tally(fired)).toEqual({ 409: 10 });
    expect(codesAt(fired, 409)).toEqual(['INVALID_STATE']);
    expect(await fileRows(world, done.id)).toHaveLength(1);
  });
});
