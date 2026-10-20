import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import {
  adminOf,
  getPlaybookAs,
  miniPlaybookYaml,
  publishPlaybookAs,
  uploadPlaybookText,
  type PageDto,
  type PlaybookDto,
  type PlaybookSummaryDto,
  type TemplateDto,
  type UploadResultDto,
} from '../../../../test/fixtures/playbooks.js';
import { expectOk, githubUser } from '../../../../test/fixtures/teams.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import { World } from '../../../../test/fixtures/world.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

/*
 * S5-01: uploadPlaybook, publishPlaybook, adminListPlaybooks, listPlaybooks, getPlaybook, getTemplate
 * (FR-PLAY-01, -03, -04, -05, -07, FR-WORK-02). They fail until S5-02 and S5-03 are done.
 * Versions: every test uploads a fresh version of its own product type or a growing minor of web_service,
 * because a version must be strictly greater than the last one of the type (FR-PLAY-03).
 */

let minor = 10;
const nextVersion = (): string => `9.${(minor += 1)}.0`;

describeInfra(
  'S5 playbooks: upload, publication and reading (FR-PLAY-01..05)',
  ['db', 'redis'],
  () => {
    let world: World;
    let admin: UserFixture;
    let member: UserFixture;

    beforeAll(async () => {
      world = await World.start({ worker: false });
      await world.ensureCatalog(['pm', 'ba', 'backend', 'frontend', 'qa']);
      admin = await adminOf(world);
      member = await githubUser(world, 'playbook-member');
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    const upload = async (
      version = nextVersion(),
      productType?: string,
    ): Promise<UploadResultDto> =>
      expectOk<UploadResultDto>(
        'uploadPlaybook',
        await uploadPlaybookText(
          world,
          admin,
          miniPlaybookYaml({ version, ...(productType ? { productType } : {}) }),
        ),
        201,
      );

    describe('uploadPlaybook', () => {
      it('FR-PLAY-01, FR-PLAY-05: the administrator uploads the YAML file -> 201, a draft, Location of the resource', async () => {
        const version = nextVersion();
        const response = await uploadPlaybookText(world, admin, miniPlaybookYaml({ version }));
        const body = expectOk<UploadResultDto>('uploadPlaybook', response, 201);
        expect(body.playbook).toMatchObject({
          productTypeCode: 'web_service',
          title: 'Мини-сценарий',
          version,
          status: 'draft',
          totalDays: 28,
        });
        expect(body.playbook.publishedAt ?? null).toBeNull();
        expect(String(response.headers.location)).toContain(body.playbook.id);
      });

      it('FR-PLAY-07: 28 days is outside 10-16 weeks -> a warning in warnings[], not an error', async () => {
        const body = await upload();
        expect(body.warnings.length).toBeGreaterThanOrEqual(1);
        for (const warning of body.warnings) {
          expect(warning.code.length).toBeGreaterThan(0);
          expect(warning.message.length).toBeGreaterThan(0);
        }
      });

      it('FR-PLAY-01: stages, steps, review items and fallbacks are stored as data (getPlaybook of the draft)', async () => {
        const { playbook } = await upload();
        const full = await getPlaybookAs(world, admin, playbook.id);
        expect(full.stages.map((s) => s.key)).toEqual(['mini_s1', 'mini_s2', 'mini_s3']);
        expect(full.stages.map((s) => s.ordinal)).toEqual([1, 2, 3]);
        expect(full.stages.map((s) => s.durationDays)).toEqual([7, 14, 7]);
        const spec = full.stages[0]?.steps.find((s) => s.key === 'mini_spec');
        expect(spec).toMatchObject({
          type: 'artifact',
          submission: 'file',
          required: true,
          ownerRole: 'backend',
          reviewChecklist: true,
          reviewItems: ['Записаны цели и не-цели?', 'Описаны альтернативы?', 'Указаны риски?'],
          autoChecks: ['file_ok', 'sha_dedup'],
        });
        const charter = full.stages[0]?.steps.find((s) => s.key === 'mini_charter');
        expect(charter?.altRoles).toEqual(['ba']);
        expect(charter?.fallback).toMatchObject({ template: 'tpl_charter' });
        const kickoff = full.stages[0]?.steps.find((s) => s.key === 'mini_kickoff');
        expect(kickoff).toMatchObject({
          type: 'ritual',
          ritualKind: 'call',
          ownerRole: 'any',
          fallback: null,
        });
      });

      it('FR-PLAY-05: the source text and its SHA-256 are kept as uploaded', async () => {
        const text = miniPlaybookYaml({ version: nextVersion() });
        const body = expectOk<UploadResultDto>(
          'uploadPlaybook',
          await uploadPlaybookText(world, admin, text),
          201,
        );
        const rows = await world.sql<{ source_text: string; same: boolean }[]>`
        SELECT source_text,
               source_sha256 = decode(${createHash('sha256').update(text).digest('hex')}, 'hex') AS same
          FROM playbooks.playbook WHERE id = ${body.playbook.id}`;
        expect(rows[0]?.source_text).toBe(text);
        expect(rows[0]?.same).toBe(true);
      });

      it('FR-PLAY-01: application/json is accepted as well (the contract: "Также принимается application/json")', async () => {
        const version = nextVersion();
        const file = {
          product_type: 'web_service',
          title: 'JSON-сценарий',
          version,
          total_days: 7,
          stages: [
            {
              key: 'json_s1',
              title: 'Этап',
              goal: 'Цель',
              duration_days: 7,
              exit_criteria: 'Критерий',
              steps: [
                {
                  key: 'json_final_links',
                  title: 'Ссылка на релиз',
                  description: 'Публичный URL релиза и репозиторий.',
                  type: 'artifact',
                  submission: 'link',
                  required: true,
                  owner_role: 'any',
                  fallback: null,
                  review_checklist: false,
                  auto_checks: ['link_https', 'release_alive_web', 'repo_final'],
                  sources: ['https://sre.google/sre-book/launch-checklist/'],
                },
              ],
            },
          ],
        };
        const response = await uploadPlaybookText(world, admin, JSON.stringify(file), {
          contentType: 'application/json',
        });
        const body = expectOk<UploadResultDto>('uploadPlaybook', response, 201);
        expect(body.playbook).toMatchObject({ version, status: 'draft', totalDays: 7 });
      });

      it('FR-PLAY-04: a new product type comes with the file; it is inactive until the administrator enables it', async () => {
        const body = await upload('1.0.0', 'ritual_demo');
        expect(body.playbook.productTypeCode).toBe('ritual_demo');
        const types = await world.sql<{ code: string; active: boolean }[]>`
        SELECT code, active FROM playbooks.product_type WHERE code = 'ritual_demo'`;
        expect(types).toEqual([{ code: 'ritual_demo', active: false }]);
      });

      it('FR-PLAY-03: the same version of the same type again -> 409 PLAYBOOK_VERSION_NOT_GREATER, nothing is stored', async () => {
        const { playbook } = await upload('2.0.0', 'semver_demo');
        const again = await uploadPlaybookText(
          world,
          admin,
          miniPlaybookYaml({ version: '2.0.0', productType: 'semver_demo' }),
        );
        expectProblem('uploadPlaybook', again, 409, 'PLAYBOOK_VERSION_NOT_GREATER');
        const rows = await world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM playbooks.playbook
         WHERE product_type_code = 'semver_demo' AND version = '2.0.0'`;
        expect(rows[0]?.n).toBe(1);
        expect(playbook.version).toBe('2.0.0');
      });

      it('FR-PLAY-03: a lower version -> 409; semver is compared by numbers (2.10.0 > 2.9.0), not as text', async () => {
        await upload('2.9.0', 'semver_demo');
        expectProblem(
          'uploadPlaybook',
          await uploadPlaybookText(
            world,
            admin,
            miniPlaybookYaml({ version: '2.1.0', productType: 'semver_demo' }),
          ),
          409,
          'PLAYBOOK_VERSION_NOT_GREATER',
        );
        const tenth = await upload('2.10.0', 'semver_demo');
        expect(tenth.playbook.version).toBe('2.10.0');
      });

      it('FR-PLAY-03: the version of another product type does not count (strictly greater than the last of its own type)', async () => {
        const other = await upload('1.0.0', 'independent_demo');
        expect(other.playbook.version).toBe('1.0.0');
      });

      it('FR-WORK-08: the same Idempotency-Key and file -> the stored 201 (one draft); the same key and another file -> 422', async () => {
        const key = randomUUID();
        const text = miniPlaybookYaml({ version: nextVersion() });
        const first = await uploadPlaybookText(world, admin, text, { key });
        expectOk('uploadPlaybook', first, 201);
        const replay = await uploadPlaybookText(world, admin, text, { key });
        expect(replay.statusCode).toBe(201);
        expectReplayed(replay);
        expect(replay.json()).toEqual(first.json());
        const other = await uploadPlaybookText(
          world,
          admin,
          miniPlaybookYaml({ version: nextVersion() }),
          { key },
        );
        expectProblem('uploadPlaybook', other, 422, 'IDEMPOTENCY_KEY_REUSED');
      });

      it('FR-WORK-08: a request without Idempotency-Key -> 400 IDEMPOTENCY_KEY_MISSING', async () => {
        const response = await uploadPlaybookText(
          world,
          admin,
          miniPlaybookYaml({ version: nextVersion() }),
          {
            key: null,
          },
        );
        expectProblem('uploadPlaybook', response, 400, 'IDEMPOTENCY_KEY_MISSING');
      });
    });

    describe('publishPlaybook', () => {
      it('FR-PLAY-03, FR-PLAY-04: a draft becomes published with publishedAt; it is then listed for everyone', async () => {
        const { playbook } = await upload();
        const response = await publishPlaybookAs(world, admin, playbook.id);
        const published = expectOk<PlaybookSummaryDto>('publishPlaybook', response, 200);
        expect(published).toMatchObject({
          id: playbook.id,
          status: 'published',
          version: playbook.version,
        });
        expect(Date.parse(published.publishedAt ?? '')).not.toBeNaN();
        const page = expectOk<PageDto<PlaybookSummaryDto>>(
          'listPlaybooks',
          await world.as(member).get('/v1/playbooks?productType=web_service&limit=100'),
          200,
        );
        expect(page.items.map((p) => p.id)).toContain(playbook.id);
      });

      it('FR-PLAY-03: a published playbook is immutable: publishing again -> 409 PLAYBOOK_PUBLISHED_IMMUTABLE', async () => {
        const { playbook } = await upload();
        expectOk('publishPlaybook', await publishPlaybookAs(world, admin, playbook.id), 200);
        const again = await publishPlaybookAs(world, admin, playbook.id);
        expectProblem('publishPlaybook', again, 409, 'PLAYBOOK_PUBLISHED_IMMUTABLE');
      });

      it('FR-WORK-08: the repeat with the same key returns the stored 200 instead of the immutability error', async () => {
        const { playbook } = await upload();
        const key = randomUUID();
        const first = await publishPlaybookAs(world, admin, playbook.id, { key });
        expectOk('publishPlaybook', first, 200);
        const replay = await publishPlaybookAs(world, admin, playbook.id, { key });
        expect(replay.statusCode).toBe(200);
        expectReplayed(replay);
      });

      it('FR-PLAY-03: the published stages cannot be changed even by SQL (trigger on stage, step, step_review_item, step_fallback)', async () => {
        const { playbook } = await upload();
        expectOk('publishPlaybook', await publishPlaybookAs(world, admin, playbook.id), 200);
        await expect(
          world.sql`UPDATE playbooks.stage SET title = 'changed' WHERE playbook_id = ${playbook.id}`,
        ).rejects.toThrow();
        await expect(
          world.sql`DELETE FROM playbooks.step WHERE playbook_id = ${playbook.id}`,
        ).rejects.toThrow();
      });

      it('FR-PLAY-05: an unknown playbook id -> 404', async () => {
        const response = await publishPlaybookAs(world, admin, randomUUID());
        expectProblem('publishPlaybook', response, 404, 'NOT_FOUND');
      });
    });

    describe('reading', () => {
      it('FR-PLAY-05: adminListPlaybooks shows drafts and published, with the page cursor', async () => {
        const draft = (await upload()).playbook;
        const published = (await upload()).playbook;
        expectOk('publishPlaybook', await publishPlaybookAs(world, admin, published.id), 200);
        const first = expectOk<PageDto<PlaybookSummaryDto>>(
          'adminListPlaybooks',
          await world.as(admin).get('/v1/admin/playbooks?limit=2'),
          200,
        );
        expect(first.items).toHaveLength(2);
        expect(first.nextCursor).not.toBeNull();
        const all = expectOk<PageDto<PlaybookSummaryDto>>(
          'adminListPlaybooks',
          await world.as(admin).get('/v1/admin/playbooks?limit=100&productType=web_service'),
          200,
        );
        const byId = new Map(all.items.map((p) => [p.id, p.status]));
        expect(byId.get(draft.id)).toBe('draft');
        expect(byId.get(published.id)).toBe('published');
      });

      it('FR-PLAY-03: listPlaybooks lists only published playbooks (a draft is not there)', async () => {
        const draft = (await upload()).playbook;
        const page = expectOk<PageDto<PlaybookSummaryDto>>(
          'listPlaybooks',
          await world.as(member).get('/v1/playbooks?limit=100'),
          200,
        );
        expect(page.items.map((p) => p.id)).not.toContain(draft.id);
        for (const item of page.items) expect(item.status).toBe('published');
      });

      it('FR-PLAY-03: listPlaybooks filters by productType', async () => {
        const page = expectOk<PageDto<PlaybookSummaryDto>>(
          'listPlaybooks',
          await world.as(member).get('/v1/playbooks?productType=ml_product&limit=100'),
          200,
        );
        for (const item of page.items) expect(item.productTypeCode).toBe('ml_product');
      });

      it('FR-PLAY-01: getPlaybook of a published playbook is open to every signed-in user (stages, steps, fallbacks)', async () => {
        const { playbook } = await upload();
        expectOk('publishPlaybook', await publishPlaybookAs(world, admin, playbook.id), 200);
        const full = expectOk<PlaybookDto>(
          'getPlaybook',
          await world.as(member).get(`/v1/playbooks/${playbook.id}`),
          200,
        );
        expect(full.stages).toHaveLength(3);
        expect(full.stages[2]?.steps.map((s) => s.key)).toEqual([
          'mini_final_links',
          'mini_wrapup',
        ]);
      });

      it('FR-PLAY-01: a draft is visible to the administrator only; others get 404 (not 403)', async () => {
        const { playbook } = await upload();
        expectOk('getPlaybook', await world.as(admin).get(`/v1/playbooks/${playbook.id}`), 200);
        const response = await world.as(member).get(`/v1/playbooks/${playbook.id}`);
        expectProblem('getPlaybook', response, 404, 'NOT_FOUND');
      });

      it('FR-PLAY-01: an unknown playbook id -> 404; an id that is not a UUID -> 400', async () => {
        expectProblem(
          'getPlaybook',
          await world.as(member).get(`/v1/playbooks/${randomUUID()}`),
          404,
          'NOT_FOUND',
        );
        expect((await world.as(member).get('/v1/playbooks/not-a-uuid')).statusCode).toBe(400);
      });
    });

    describe('getTemplate (FR-WORK-02)', () => {
      it('FR-WORK-02: tpl_charter is in the catalog of platform templates with its section headings', async () => {
        const template = expectOk<TemplateDto>(
          'getTemplate',
          await world.as(member).get('/v1/templates/tpl_charter'),
          200,
        );
        expect(template.key).toBe('tpl_charter');
        expect(Number.isInteger(template.version)).toBe(true);
        expect(template.title.length).toBeGreaterThan(0);
        for (const heading of ['Цель проекта', 'Definition of Done v0', 'No-gos']) {
          expect(template.bodyMd).toContain(heading);
        }
      });

      it('FR-WORK-02: every template key of docs/playbooks.md section 5.1 exists', async () => {
        for (const key of [
          'tpl_retro',
          'tpl_design_doc',
          'tpl_release_checklist',
          'tpl_model_card',
        ]) {
          const response = await world.as(member).get(`/v1/templates/${key}`);
          expect(response.statusCode, key).toBe(200);
        }
      });

      it('FR-WORK-02: the latest version is returned', async () => {
        const current = expectOk<TemplateDto>(
          'getTemplate',
          await world.as(member).get('/v1/templates/tpl_adr'),
          200,
        );
        await world.sql`
        INSERT INTO playbooks.platform_template (key, version, title, body_md)
        VALUES ('tpl_adr', ${current.version + 1}, 'ADR v2', '# ADR v2')`;
        const latest = expectOk<TemplateDto>(
          'getTemplate',
          await world.as(member).get('/v1/templates/tpl_adr'),
          200,
        );
        expect(latest).toMatchObject({ version: current.version + 1, title: 'ADR v2' });
      });

      it('FR-WORK-02: an unknown key -> 404; no session -> 401', async () => {
        expectProblem(
          'getTemplate',
          await world.as(member).get('/v1/templates/tpl_unknown'),
          404,
          'NOT_FOUND',
        );
        expectProblem(
          'getTemplate',
          await world.anonymous().get('/v1/templates/tpl_charter'),
          401,
          'UNAUTHENTICATED',
        );
      });
    });

    describe('authorization of the playbook operations (FR-AUTH-08)', () => {
      it('FR-AUTH-08: uploadPlaybook, publishPlaybook and adminListPlaybooks by a non-administrator -> 403 ADMIN_ONLY; nothing is stored', async () => {
        const before = await world.sql<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM playbooks.playbook`;
        const version = nextVersion();
        expectProblem(
          'uploadPlaybook',
          await uploadPlaybookText(world, member, miniPlaybookYaml({ version })),
          403,
          'ADMIN_ONLY',
        );
        const { playbook } = await upload();
        expectProblem(
          'publishPlaybook',
          await publishPlaybookAs(world, member, playbook.id),
          403,
          'ADMIN_ONLY',
        );
        expectProblem(
          'adminListPlaybooks',
          await world.as(member).get('/v1/admin/playbooks'),
          403,
          'ADMIN_ONLY',
        );
        const after = await world.sql<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM playbooks.playbook`;
        expect(after[0]?.n).toBe((before[0]?.n ?? 0) + 1);
        const row = await world.sql<
          { status: string }[]
        >`SELECT status FROM playbooks.playbook WHERE id = ${playbook.id}`;
        expect(row[0]?.status).toBe('draft');
      });

      it('FR-AUTH-03: without a session every playbook operation -> 401', async () => {
        const { playbook } = await upload();
        const anonymous = world.anonymous();
        for (const [operationId, response] of [
          ['listPlaybooks', await anonymous.get('/v1/playbooks')],
          ['getPlaybook', await anonymous.get(`/v1/playbooks/${playbook.id}`)],
          ['adminListPlaybooks', await anonymous.get('/v1/admin/playbooks')],
          [
            'publishPlaybook',
            await anonymous.post(`/v1/admin/playbooks/${playbook.id}/publication`),
          ],
        ] as const) {
          expectProblem(operationId, response, 401, 'UNAUTHENTICATED');
        }
      });
    });
  },
);
