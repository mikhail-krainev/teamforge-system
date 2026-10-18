import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { miniPlaybookYaml } from '../../test/fixtures/playbooks.js';
import { team } from '../../test/fixtures/teams.js';
import { World } from '../../test/fixtures/world.js';
import { describeInfra } from '../../test/helpers/infra.js';
import type { Database } from '../platform/db/db.module.js';
import { loadPlaybookFile } from './playbooks-load-run.js';

const WEB_STUB = '00000000-0000-7000-8000-0000000a0001';
const ML_STUB = '00000000-0000-7000-8000-0000000a0002';

interface TeamPin {
  playbookId: string;
  version: number;
  updatedAtMs: number;
}

describeInfra(
  'playbooks:load moves forming teams off the stub playbook (S5 review item 6)',
  ['db'],
  () => {
    let world: World;

    beforeAll(async () => {
      world = await World.start({ worker: false });
    });

    afterAll(async () => {
      if (world) await world.close();
    });

    const pinOf = async (teamId: string): Promise<TeamPin> => {
      const [row] = await world.sql<
        { playbook_id: string; version: number; updated_at: Date | string }[]
      >`
        SELECT playbook_id, version, updated_at FROM teams.team WHERE id = ${teamId}`;
      if (row === undefined) throw new Error('no team');
      return {
        playbookId: row.playbook_id,
        version: row.version,
        updatedAtMs: new Date(row.updated_at).getTime(),
      };
    };

    const load = (version: string) =>
      drizzle(world.sql).transaction((transaction) =>
        loadPlaybookFile(transaction as unknown as Database, miniPlaybookYaml({ version }), {
          uploadedBy: '00000000-0000-0000-0000-000000000000',
          publish: true,
          now: new Date(),
        }),
      );

    it('after a successful load, forming teams on a stub get the new playbook; the rest are left alone', async () => {
      const forming = await team(world, { members: 1, openSeats: 1 });
      const started = await team(world, { members: 2, openSeats: 1, status: 'active' });
      const onReal = await team(world, { members: 1, openSeats: 1 });
      const otherType = await team(world, { members: 1, openSeats: 1 });
      await world.sql`UPDATE teams.team SET playbook_id = ${WEB_STUB} WHERE id IN (${forming.id}, ${started.id})`;
      await world.sql`UPDATE teams.team SET product_type_code = 'ml_product', playbook_id = ${ML_STUB} WHERE id = ${otherType.id}`;
      const [before, realBefore, startedBefore, otherBefore] = await Promise.all([
        pinOf(forming.id),
        pinOf(onReal.id),
        pinOf(started.id),
        pinOf(otherType.id),
      ]);

      const result = await load('9.1.0');
      expect(result.playbook.status).toBe('published');

      const after = await pinOf(forming.id);
      expect(after.playbookId).toBe(result.playbook.id);
      expect(after.version).toBe(before.version + 1);
      expect(after.updatedAtMs).toBeGreaterThan(before.updatedAtMs);
      expect(await pinOf(onReal.id)).toEqual(realBefore);
      expect(await pinOf(started.id)).toEqual(startedBefore);
      expect(await pinOf(otherType.id)).toEqual(otherBefore);
    });

    it('a load that only creates a draft, or repeats an unchanged file, moves nobody', async () => {
      const forming = await team(world, { members: 1, openSeats: 1 });
      await world.sql`UPDATE teams.team SET playbook_id = ${WEB_STUB} WHERE id = ${forming.id}`;
      const before = await pinOf(forming.id);
      const draft = await drizzle(world.sql).transaction((transaction) =>
        loadPlaybookFile(
          transaction as unknown as Database,
          miniPlaybookYaml({ version: '9.2.0' }),
          {
            uploadedBy: '00000000-0000-0000-0000-000000000000',
            publish: false,
            now: new Date(),
          },
        ),
      );
      expect(draft.playbook.status).toBe('draft');
      expect(await pinOf(forming.id)).toEqual(before);
    });
  },
);
