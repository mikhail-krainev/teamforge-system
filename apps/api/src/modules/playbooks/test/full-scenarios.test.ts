import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  adminOf,
  getPlaybookAs,
  miniPlaybookYaml,
  publishPlaybookAs,
  publishText,
  seedPlaybookYaml,
  uploadPlaybookText,
  type PageDto,
  type PlaybookSummaryDto,
} from '../../../../test/fixtures/playbooks.js';
import { expectOk, githubUser, team, type TeamDto } from '../../../../test/fixtures/teams.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import { World } from '../../../../test/fixtures/world.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { stagesOf } from '../../../../test/fixtures/workspace.js';

/*
 * S5-01 -> S5-02/S5-03 checks of the plan: the two real scenarios of docs/playbooks.md load and publish
 * (total_days 84 and 91), the stubs 0.0.1 are replaced by 1.0.0, a team stays on the version it was created
 * on (FR-PLAY-03), and a product type that no code knows works from data alone (FR-PLAY-04).
 * The seed files are apps/api/seeds/playbooks/{web_service,ml_product}.yaml (extracted by S5-02).
 */

const ROLES = [
  'pm',
  'frontend',
  'backend',
  'mobile',
  'ba',
  'product_analyst',
  'system_analyst',
  'designer',
  'ml_engineer',
  'data_engineer',
  'qa',
  'devops',
];

describeInfra(
  'S5 playbooks: the real scenarios, pinning, a new product type (FR-PLAY-03, -04, -07)',
  ['db', 'redis'],
  () => {
    let world: World;
    let admin: UserFixture;

    beforeAll(async () => {
      world = await World.start({ worker: false });
      await world.ensureCatalog(ROLES);
      admin = await adminOf(world);
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    const latestVersion = async (productType: string): Promise<string | undefined> => {
      const page = expectOk<PageDto<PlaybookSummaryDto>>(
        'listPlaybooks',
        await world.as(admin).get(`/v1/playbooks?productType=${productType}&limit=100`),
        200,
      );
      return page.items
        .map((p) => p.version)
        .sort((a, b) => {
          const [x, y] = [a, b].map((v) => v.split('.').map(Number));
          return (
            (x?.[0] ?? 0) - (y?.[0] ?? 0) ||
            (x?.[1] ?? 0) - (y?.[1] ?? 0) ||
            (x?.[2] ?? 0) - (y?.[2] ?? 0)
          );
        })
        .at(-1);
    };

    it('S5-02: web_service 1.0.0 from docs/playbooks.md 3.2 loads and publishes: 84 days, 8 stages, every obligatory step has an owner', async () => {
      const { published } = await publishText(world, seedPlaybookYaml('web_service'));
      expect(published).toMatchObject({
        productTypeCode: 'web_service',
        version: '1.0.0',
        status: 'published',
        totalDays: 84,
      });
      const full = await getPlaybookAs(world, admin, published.id);
      expect(full.stages).toHaveLength(8);
      expect(full.stages.reduce((sum, s) => sum + s.durationDays, 0)).toBe(84);
      const last = full.stages.at(-1);
      expect(last?.steps.some((s) => s.key === 'w8_final_links' && s.required)).toBe(true);
      for (const stage of full.stages) {
        for (const step of stage.steps) {
          if (step.ownerRole !== 'any') expect(step.fallback, step.key).not.toBeNull();
          else expect(step.fallback, step.key).toBeNull();
          expect(step.sources.length, step.key).toBeGreaterThan(0);
        }
      }
    });

    it('S5-02: ml_product 1.0.0 from docs/playbooks.md 4.3 loads and publishes: 91 days, with m8_final_links', async () => {
      const { published, upload } = await publishText(world, seedPlaybookYaml('ml_product'));
      expect(published).toMatchObject({
        productTypeCode: 'ml_product',
        version: '1.0.0',
        totalDays: 91,
      });
      // 13 weeks is inside 10-16 weeks (FR-PLAY-07): no duration warning for the real scenarios.
      expect(upload.warnings).toEqual([]);
      const full = await getPlaybookAs(world, admin, published.id);
      expect(full.stages.at(-1)?.steps.some((s) => s.key === 'm8_final_links')).toBe(true);
    });

    it('S5-02: the loader is idempotent by content: the same seed again is not a new version (409 PLAYBOOK_VERSION_NOT_GREATER)', async () => {
      const response = await uploadPlaybookText(world, admin, seedPlaybookYaml('web_service'));
      expect(response.statusCode).toBe(409);
      expect(response.json<{ code: string }>().code).toBe('PLAYBOOK_VERSION_NOT_GREATER');
    });

    it('S5-03: a team created after the stubs 0.0.1 are replaced gets 1.0.0; a team created before keeps its version (FR-PLAY-03)', async () => {
      // the world is a fresh clone: teams created before the seed run are pinned to the slice 3 stub
      const lead = await githubUser(world, 'pinning-lead');
      const before = expectOk<TeamDto>(
        'createTeam',
        await world.as(lead).post('/v1/teams', {
          name: 'Команда до публикации',
          description: 'pins the playbook that is latest now',
          timezone: 'Europe/Moscow',
          hoursPerWeek: 10,
          productTypeCode: 'web_service',
        }),
        201,
      );
      expect(before.playbookVersion).toBe(await latestVersion('web_service'));
      const newer = await publishText(world, miniPlaybookYaml({ version: '1.0.1' }));
      expect(newer.published.version).toBe('1.0.1');
      const after = await team(world, { members: 1, openSeats: 1 });
      expect(after.dto.playbookVersion).toBe('1.0.1');
      const old = expectOk<TeamDto>(
        'getTeam',
        await world.as(lead).get(`/v1/teams/${before.id}`),
        200,
      );
      expect(old.playbookVersion).toBe(before.playbookVersion);
      expect(old.playbookId).toBe(before.playbookId);
    });

    it('FR-PLAY-03: a team keeps its version after a newer one is published, and its route is built from the old one', async () => {
      const lead = await githubUser(world, 'pinned-route-lead');
      const created = expectOk<TeamDto>(
        'createTeam',
        await world.as(lead).post('/v1/teams', {
          name: 'Команда на старой версии',
          description: 'route from the pinned version',
          timezone: 'Europe/Moscow',
          hoursPerWeek: 10,
          productTypeCode: 'web_service',
        }),
        201,
      );
      const pinnedId = created.playbookId;
      await publishText(world, miniPlaybookYaml({ version: '1.0.2' }));
      expectOk('startProject', await world.as(lead).post(`/v1/teams/${created.id}/start`), 200);
      const stages = await stagesOf(world, lead, created.id);
      const pinned = await getPlaybookAs(world, admin, pinnedId);
      expect(stages.items.map((s) => s.key)).toEqual(pinned.stages.map((s) => s.key));
    });

    it('FR-PLAY-04: a new product type needs no code: upload, publish, enable, a team gets its route', async () => {
      const uploaded = await uploadPlaybookText(
        world,
        admin,
        miniPlaybookYaml({
          productType: 'data_dashboard',
          version: '1.0.0',
          title: 'Дашборд данных',
        }),
      );
      const body = expectOk<{ playbook: PlaybookSummaryDto }>('uploadPlaybook', uploaded, 201);
      expectOk('publishPlaybook', await publishPlaybookAs(world, admin, body.playbook.id), 200);
      await world.sql`UPDATE playbooks.product_type SET active = true WHERE code = 'data_dashboard'`;

      const lead = await githubUser(world, 'new-type-lead');
      const created = expectOk<TeamDto>(
        'createTeam',
        await world.as(lead).post('/v1/teams', {
          name: 'Команда нового типа',
          description: 'route from data only',
          timezone: 'Europe/Moscow',
          hoursPerWeek: 10,
          productTypeCode: 'data_dashboard',
        }),
        201,
      );
      expect(created.playbookId).toBe(body.playbook.id);
      expectOk('startProject', await world.as(lead).post(`/v1/teams/${created.id}/start`), 200);
      const stages = await stagesOf(world, lead, created.id);
      expect(stages.items.map((s) => s.key)).toEqual(['mini_s1', 'mini_s2', 'mini_s3']);
      expect(stages.items.map((s) => s.status)).toEqual(['open', 'pending', 'pending']);
    });
  },
);
