import { afterAll, beforeAll, expect, it } from 'vitest';
import { codesAt, expectReplayOf, fireAll, tally, winnerOf } from '../fixtures/concurrency.js';
import { expectOk } from '../fixtures/teams.js';
import { expectNoDeadlocks } from '../fixtures/teams-db.js';
import {
  adminOf,
  miniPlaybookYaml,
  publishPlaybookAs,
  uploadPlaybookText,
  type UploadResultDto,
} from '../fixtures/playbooks.js';
import type { UserFixture } from '../fixtures/index.js';
import { World } from '../fixtures/world.js';
import { describeInfra } from '../helpers/infra.js';

/*
 * Publication races (plan, "Тесты среза": "Параллельная публикация одной версии сценария x10 -> 1 успех"):
 * `playbook_type_version_uq (product_type_code, version)` and the immutability of a published playbook.
 */
describeInfra('Playbooks: parallel upload and publication (FR-PLAY-03)', ['db', 'redis'], () => {
  let world: World;
  let admin: UserFixture;
  let deadlocksBefore = 0;

  beforeAll(async () => {
    world = await World.start({ worker: false });
    await world.ensureCatalog(['pm', 'ba', 'backend', 'frontend', 'qa']);
    admin = await adminOf(world);
    deadlocksBefore = await world.deadlocks();
  });

  afterAll(async () => {
    if (!world) return;
    await expectNoDeadlocks(world, deadlocksBefore);
    await world.close();
  });

  it('10 uploads of the SAME version at once -> 1 x 201, 9 x 409 PLAYBOOK_VERSION_NOT_GREATER; one draft is stored', async () => {
    const text = miniPlaybookYaml({ version: '30.0.0' });
    const fired = await fireAll(10, (_i, key) => uploadPlaybookText(world, admin, text, { key }));
    expect(tally(fired)).toEqual({ 201: 1, 409: 9 });
    expect(codesAt(fired, 409)).toEqual(['PLAYBOOK_VERSION_NOT_GREATER']);
    const rows = await world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM playbooks.playbook WHERE product_type_code = 'web_service' AND version = '30.0.0'`;
    expect(rows[0]?.n).toBe(1);
    const stages = await world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM playbooks.stage s JOIN playbooks.playbook p ON p.id = s.playbook_id WHERE p.version = '30.0.0'`;
    expect(stages[0]?.n).toBe(3);
  });

  it('10 publications of the SAME draft at once -> 1 x 200, 9 x 409 PLAYBOOK_PUBLISHED_IMMUTABLE; published once', async () => {
    const uploaded = expectOk<UploadResultDto>(
      'uploadPlaybook',
      await uploadPlaybookText(world, admin, miniPlaybookYaml({ version: '31.0.0' })),
      201,
    );
    const id = uploaded.playbook.id;
    const fired = await fireAll(10, (_i, key) => publishPlaybookAs(world, admin, id, { key }));
    expect(tally(fired)).toEqual({ 200: 1, 409: 9 });
    expect(codesAt(fired, 409)).toEqual(['PLAYBOOK_PUBLISHED_IMMUTABLE']);
    const rows = await world.sql<
      { status: string }[]
    >`SELECT status FROM playbooks.playbook WHERE id = ${id}`;
    expect(rows[0]?.status).toBe('published');
    const winner = winnerOf(fired, 200);
    expectReplayOf(winner, await publishPlaybookAs(world, admin, id, { key: winner.key }));
  });

  it('10 uploads of DIFFERENT versions at once all succeed and each stores its own stages (no mix-up of rows between drafts)', async () => {
    const versions = Array.from({ length: 10 }, (_, i) => `32.${i}.0`);
    const fired = await fireAll(10, (i, key) =>
      uploadPlaybookText(world, admin, miniPlaybookYaml({ version: versions[i] ?? '32.99.0' }), {
        key,
      }),
    );
    expect(tally(fired)).toEqual({ 201: 10 });
    const rows = await world.sql<{ version: string; stages: number; steps: number }[]>`
      SELECT p.version,
             (SELECT count(*)::int FROM playbooks.stage s WHERE s.playbook_id = p.id) AS stages,
             (SELECT count(*)::int FROM playbooks.step t WHERE t.playbook_id = p.id) AS steps
        FROM playbooks.playbook p WHERE p.version LIKE '32.%'`;
    expect(rows).toHaveLength(10);
    for (const row of rows) expect([row.stages, row.steps]).toEqual([3, 10]);
  });
});
