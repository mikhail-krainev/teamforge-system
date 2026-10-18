import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  adminOf,
  miniPlaybookYaml,
  publishPlaybookAs,
  uploadPlaybookText,
  type PlaybookSummaryDto,
  type UploadResultDto,
} from '../../../../test/fixtures/playbooks.js';
import { expectOk } from '../../../../test/fixtures/teams.js';
import { team } from '../../../../test/fixtures/teams.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import { World } from '../../../../test/fixtures/world.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

const WEB_STUB = '00000000-0000-7000-8000-0000000a0001';
const FIRST_MINOR = 60;

describeInfra('S5 review M1/M4: publishPlaybook moves forming stub teams', ['db', 'redis'], () => {
  let world: World;
  let admin: UserFixture;
  let minor = FIRST_MINOR;

  beforeAll(async () => {
    world = await World.start({ worker: false });
    await world.ensureCatalog(['pm', 'ba', 'backend', 'frontend', 'qa']);
    admin = await adminOf(world);
  });

  afterAll(async () => {
    if (world) await world.close();
  });

  const pinOf = async (teamId: string): Promise<{ playbookId: string; version: number }> => {
    const [row] = await world.sql<{ playbook_id: string; version: number }[]>`
      SELECT playbook_id, version FROM teams.team WHERE id = ${teamId}`;
    if (row === undefined) throw new Error('no team');
    return { playbookId: row.playbook_id, version: row.version };
  };

  const uploadDraft = async (): Promise<UploadResultDto> =>
    expectOk<UploadResultDto>(
      'uploadPlaybook',
      await uploadPlaybookText(world, admin, miniPlaybookYaml({ version: `9.${(minor += 1)}.0` })),
      201,
    );

  const publish = async (playbookId: string): Promise<PlaybookSummaryDto> =>
    expectOk<PlaybookSummaryDto>(
      'publishPlaybook',
      await publishPlaybookAs(world, admin, playbookId),
      200,
    );

  it('publication over HTTP moves a forming team off the stub, bumps its version; started and real-playbook teams stay', async () => {
    const forming = await team(world, { members: 1, openSeats: 1 });
    const started = await team(world, { members: 2, openSeats: 1, status: 'active' });
    const onReal = await team(world, { members: 1, openSeats: 1 });
    await world.sql`UPDATE teams.team SET playbook_id = ${WEB_STUB} WHERE id IN (${forming.id}, ${started.id})`;
    const [formingBefore, startedBefore, realBefore] = await Promise.all([
      pinOf(forming.id),
      pinOf(started.id),
      pinOf(onReal.id),
    ]);

    const published = await publish((await uploadDraft()).playbook.id);

    expect(await pinOf(forming.id)).toEqual({
      playbookId: published.id,
      version: formingBefore.version + 1,
    });
    expect(await pinOf(started.id)).toEqual(startedBefore);
    expect(await pinOf(onReal.id)).toEqual(realBefore);
  });

  it('a stub is a playbook without stages, not one with source_text = stub (M4)', async () => {
    const draft = await uploadDraft();
    await world.sql`UPDATE playbooks.playbook SET source_text = 'stub' WHERE id = ${draft.playbook.id}`;
    const withStages = await publish(draft.playbook.id);
    const onLabelled = await team(world, { members: 1, openSeats: 1 });
    await world.sql`UPDATE teams.team SET playbook_id = ${withStages.id} WHERE id = ${onLabelled.id}`;
    const before = await pinOf(onLabelled.id);

    await publish((await uploadDraft()).playbook.id);

    expect(await pinOf(onLabelled.id)).toEqual(before);
  });
});
