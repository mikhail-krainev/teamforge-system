import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  miniPlaybookYaml,
  publishText,
  type PlaybookSummaryDto,
} from '../../../../test/fixtures/playbooks.js';
import { expectOk, team, type TeamDto } from '../../../../test/fixtures/teams.js';
import { World } from '../../../../test/fixtures/world.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { PLAYBOOKS_API, type PlaybooksApi } from '../../playbooks/public.js';

const WEB_STUB = '00000000-0000-7000-8000-0000000a0001';
const DAY_MS = 86_400_000;

describeInfra(
  'S5 review L1: startProject uses the playbook pinned under the lock',
  ['db', 'redis'],
  () => {
    let world: World;

    beforeAll(async () => {
      world = await World.start({ worker: false });
    });

    afterAll(async () => {
      if (world) await world.close();
    });

    it('a rebind between the reference read and the team lock gives the planned end of the new playbook', async () => {
      const forming = await team(world, { members: 1, openSeats: 1 });
      await world.sql`UPDATE teams.team SET playbook_id = ${WEB_STUB} WHERE id = ${forming.id}`;
      // The first `duration_days: 7` is the first stage: 7 -> 9 days makes the total 30.
      const text = miniPlaybookYaml({ version: '9.80.0' })
        .replace('duration_days: 7', 'duration_days: 9')
        .replace('total_days: 28', 'total_days: 30');
      const published: PlaybookSummaryDto = (await publishText(world, text)).published;
      // publishText rebound the team already; pin it back to the stub, the rebind happens inside the start.
      await world.sql`UPDATE teams.team SET playbook_id = ${WEB_STUB} WHERE id = ${forming.id}`;
      const api = world.app.get<PlaybooksApi>(PLAYBOOKS_API, { strict: false });
      const original = api.getDefinition.bind(api);
      let rebound = false;
      api.getDefinition = async (id) => {
        const definition = await original(id);
        if (!rebound && id === WEB_STUB) {
          rebound = true;
          await world.sql`
            UPDATE teams.team SET playbook_id = ${published.id}, version = version + 1
             WHERE id = ${forming.id}`;
        }
        return definition;
      };

      const started = expectOk<TeamDto>(
        'startProject',
        await world.as(forming.lead).post(`/v1/teams/${forming.id}/start`),
        200,
      );

      expect(rebound).toBe(true);
      expect(published.totalDays).toBe(30);
      const span = Date.parse(started.plannedEndAt ?? '') - Date.parse(started.startedAt ?? '');
      expect(span).toBe(30 * DAY_MS);
    });
  },
);
