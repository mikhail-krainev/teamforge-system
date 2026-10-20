import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFor } from '../../../../../test/helpers/db-url.js';
import { describeInfra } from '../../../../../test/helpers/infra.js';
import { ActorPolicies } from '../../../../platform/authz/actor-policies.js';
import type { Database } from '../../../../platform/db/db.module.js';
import { runMigrations } from '../../../../platform/db/migrate.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { AdminProbe } from '../read/admin-probe.js';
import { PlaybookDefinitions } from '../read/playbook-definitions.js';
import { PlaybookReadService } from '../read/playbook-read.service.js';
import { PlaybookReader } from '../read/playbook-reader.js';
import { PlaybooksFacade } from '../services/playbooks-facade.service.js';
import { miniText } from './mini-playbook.fixture.js';
import { PlaybookLoader } from './playbook-loader.js';

const API_ROOT = path.resolve(import.meta.dirname, '../../../../..');
const read = (...parts: string[]): string => readFileSync(path.join(API_ROOT, ...parts), 'utf8');
const SYSTEM = '00000000-0000-0000-0000-000000000000';
const NOW = new Date('2026-10-17T10:00:00Z');

describeInfra('S5-02/S5-03 playbook loader, publication and reading (database)', ['db'], () => {
  const quiet = { prepare: false, onnotice: () => undefined } as const;
  const dbName = `tf_s5_playbooks_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const adminUrl = process.env.DATABASE_DIRECT_URL ?? '';
  const loader = new PlaybookLoader();
  let owner: postgres.Sql;
  let app: postgres.Sql;
  let db: Database;
  let roles: string[];

  /** Runs the loader in a transaction of the APPLICATION role (tf_app through PgBouncer), like production. */
  const inTx = <T>(fn: (tx: Database) => Promise<T>): Promise<T> =>
    db.transaction((tx) => fn(tx as unknown as Database));

  const ensure = (file: string, publish: boolean) =>
    inTx((tx) =>
      loader.ensureLoaded(tx, read('seeds/playbooks', file), {
        uploadedBy: SYSTEM,
        publish,
        roleCodes: roles,
        now: NOW,
      }),
    );

  const mini = (version: string, type = 'web_service'): string =>
    miniText((file) => {
      file.version = version;
      file.product_type = type;
    });

  const refused = async (promise: Promise<unknown>): Promise<DomainError> => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  };

  beforeAll(async () => {
    const admin = postgres(adminUrl, { max: 1, ...quiet });
    try {
      await admin.unsafe(`CREATE DATABASE ${dbName}`);
    } finally {
      await admin.end({ timeout: 5 });
    }
    const directUrl = databaseUrlFor(adminUrl, dbName);
    await runMigrations(directUrl);
    owner = postgres(directUrl, { max: 2, ...quiet });
    app = postgres(databaseUrlFor(process.env.DATABASE_URL ?? '', dbName), { max: 4, ...quiet });
    db = drizzle(app) as unknown as Database;
    roles = (await owner`SELECT code FROM profiles.role`).map((row) => row.code as string);
  });

  afterAll(async () => {
    await app.end({ timeout: 5 });
    await owner.end({ timeout: 5 });
    const admin = postgres(adminUrl, { max: 1, ...quiet });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });

  describe('the two real playbooks of docs/playbooks.md (seed path of the migrate container)', () => {
    it('FR-PLAY-05: both load and publish; the stubs 0.0.1 stay below the real 1.0.0', async () => {
      const web = await ensure('web_service.yaml', true);
      const ml = await ensure('ml_product.yaml', true);
      expect(web.outcome).toBe('published');
      expect(web.playbook).toMatchObject({ version: '1.0.0', status: 'published', totalDays: 84 });
      expect(ml.playbook).toMatchObject({ version: '1.0.0', status: 'published', totalDays: 91 });
      const facade = new PlaybooksFacade(db, new PlaybookDefinitions(new PlaybookReader(db)));
      expect(await facade.getLatestPublished('web_service')).toMatchObject({
        id: web.playbook.id,
        version: '1.0.0',
      });
      expect(await facade.getLatestPublished('ml_product')).toMatchObject({
        id: ml.playbook.id,
        totalDays: 91,
      });
    });

    it('FR-PLAY-05: loading the same files again changes nothing (the migrate container runs on every start)', async () => {
      const before = await owner`SELECT count(*)::int AS n FROM playbooks.playbook`;
      const again = await ensure('web_service.yaml', true);
      expect(again.outcome).toBe('unchanged');
      const after = await owner`SELECT count(*)::int AS n FROM playbooks.playbook`;
      expect(after[0]?.n).toBe(before[0]?.n);
    });

    it('FR-PLAY-01: the whole tree is stored: 8 stages, 47 and 46 steps, review items, fallbacks, sha256 of the file', async () => {
      const rows = await owner`
        SELECT p.product_type_code AS type,
               (SELECT count(*)::int FROM playbooks.stage s WHERE s.playbook_id = p.id) AS stages,
               (SELECT count(*)::int FROM playbooks.step t WHERE t.playbook_id = p.id) AS steps,
               (SELECT count(*)::int FROM playbooks.step_fallback f JOIN playbooks.step t ON t.id = f.step_id
                 WHERE t.playbook_id = p.id) AS fallbacks,
               (SELECT count(*)::int FROM playbooks.step_review_item i JOIN playbooks.step t ON t.id = i.step_id
                 WHERE t.playbook_id = p.id) AS items,
               encode(p.source_sha256, 'hex') AS sha
          FROM playbooks.playbook p WHERE p.version = '1.0.0' ORDER BY p.product_type_code`;
      expect(rows.map((r) => [r.type, r.stages, r.steps])).toEqual([
        ['ml_product', 8, 46],
        ['web_service', 8, 47],
      ]);
      for (const row of rows) {
        expect(row.fallbacks).toBeGreaterThan(10);
        expect(row.items).toBeGreaterThan(20);
        expect(row.sha).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('FR-PLAY-01: getDefinition is the stored tree, frozen and cached by id (one object for every call)', async () => {
      const facade = new PlaybooksFacade(db, new PlaybookDefinitions(new PlaybookReader(db)));
      const latest = await facade.getLatestPublished('web_service');
      const definition = await facade.getDefinition(latest?.id ?? '');
      expect(definition).toMatchObject({
        productType: 'web_service',
        version: '1.0.0',
        totalDays: 84,
      });
      expect(definition.stages.map((s) => s.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(definition.stages.reduce((sum, s) => sum + s.durationDays, 0)).toBe(84);
      const charter = definition.stages[0]?.steps.find((s) => s.key === 'w1_charter');
      expect(charter).toMatchObject({
        kind: 'artifact',
        submission: 'file',
        ownerRole: 'pm',
        altRoles: ['ba'],
        fallback: { template: 'tpl_charter', url: null },
        autoChecks: ['file_ok', 'sha_dedup', 'md_headings'],
      });
      expect(charter?.reviewItems).toHaveLength(3);
      expect(await facade.getDefinition(latest?.id ?? '')).toBe(definition);
      expect(Object.isFrozen(definition.stages[0])).toBe(true);
    });

    it('PlaybooksApi: a draft or an unknown id has no definition (404), and the failure is not cached', async () => {
      const facade = new PlaybooksFacade(db, new PlaybookDefinitions(new PlaybookReader(db)));
      const draft = await inTx((tx) => loader.upload(tx, mini('9.1.0'), SYSTEM, roles));
      expect((await refused(facade.getDefinition(draft.playbook.id))).status).toBe(404);
      expect((await refused(facade.getDefinition(randomUUID()))).status).toBe(404);
      await inTx((tx) => loader.publish(tx, draft.playbook.id, NOW));
      expect((await facade.getDefinition(draft.playbook.id)).version).toBe('9.1.0');
    });

    it('FR-PLAY-06: isActiveProductType follows product_type.active', async () => {
      const facade = new PlaybooksFacade(db, new PlaybookDefinitions(new PlaybookReader(db)));
      expect(await facade.isActiveProductType('web_service')).toBe(true);
      expect(await facade.isActiveProductType('no_such_type')).toBe(false);
    });
  });

  describe('uploading and publishing (FR-PLAY-02, -03, -04)', () => {
    it('FR-PLAY-02: a rejected file is 422 PLAYBOOK_INVALID with every error and stores nothing', async () => {
      const before = await owner`SELECT count(*)::int AS n FROM playbooks.playbook`;
      const text = read('test/fixtures/playbooks/broken/many-errors.yaml');
      const error = await refused(inTx((tx) => loader.upload(tx, text, SYSTEM, roles)));
      expect(error.status).toBe(422);
      expect(error.code).toBe('PLAYBOOK_INVALID');
      expect(error.data.errors?.length).toBeGreaterThanOrEqual(7);
      expect((await owner`SELECT count(*)::int AS n FROM playbooks.playbook`)[0]?.n).toBe(
        before[0]?.n,
      );
    });

    it('FR-PLAY-03: the version must be strictly greater than the last of the type, compared as numbers', async () => {
      await inTx((tx) => loader.upload(tx, mini('2.9.0', 'semver_type'), SYSTEM, roles));
      for (const version of ['2.9.0', '2.1.0', '1.99.0', '2.8.9']) {
        const error = await refused(
          inTx((tx) => loader.upload(tx, mini(version, 'semver_type'), SYSTEM, roles)),
        );
        expect([error.status, error.code]).toEqual([409, 'PLAYBOOK_VERSION_NOT_GREATER']);
      }
      const tenth = await inTx((tx) =>
        loader.upload(tx, mini('2.10.0', 'semver_type'), SYSTEM, roles),
      );
      expect(tenth.playbook.version).toBe('2.10.0');
      // another product type has its own line of versions
      const other = await inTx((tx) =>
        loader.upload(tx, mini('1.0.0', 'other_type'), SYSTEM, roles),
      );
      expect(other.playbook.status).toBe('draft');
    });

    it('FR-PLAY-04: the type of a new file is created inactive; the first publication makes it available', async () => {
      const { playbook } = await inTx((tx) =>
        loader.upload(tx, mini('1.0.0', 'fresh_type'), SYSTEM, roles),
      );
      const inactive =
        await owner`SELECT active FROM playbooks.product_type WHERE code = 'fresh_type'`;
      expect(inactive[0]?.active).toBe(false);
      await inTx((tx) => loader.publish(tx, playbook.id, NOW));
      const active =
        await owner`SELECT active FROM playbooks.product_type WHERE code = 'fresh_type'`;
      expect(active[0]?.active).toBe(true);
    });

    it('FR-PLAY-03: a published playbook is immutable: publishing again is 409, SQL changes are refused by triggers', async () => {
      const { playbook } = await inTx((tx) =>
        loader.upload(tx, mini('1.0.0', 'frozen_type'), SYSTEM, roles),
      );
      const published = await inTx((tx) => loader.publish(tx, playbook.id, NOW));
      expect(published).toMatchObject({ status: 'published', publishedAt: NOW.toISOString() });
      const again = await refused(inTx((tx) => loader.publish(tx, playbook.id, NOW)));
      expect([again.status, again.code]).toEqual([409, 'PLAYBOOK_PUBLISHED_IMMUTABLE']);
      const id = playbook.id;
      for (const attempt of [
        owner`UPDATE playbooks.playbook SET title = 'x' WHERE id = ${id}`,
        owner`DELETE FROM playbooks.playbook WHERE id = ${id}`,
        owner`UPDATE playbooks.stage SET title = 'x' WHERE playbook_id = ${id}`,
        owner`DELETE FROM playbooks.stage WHERE playbook_id = ${id}`,
        owner`UPDATE playbooks.step SET title = 'x' WHERE playbook_id = ${id}`,
        owner`DELETE FROM playbooks.step WHERE playbook_id = ${id}`,
        owner`UPDATE playbooks.step_review_item SET text = 'x' WHERE step_id IN (SELECT id FROM playbooks.step WHERE playbook_id = ${id})`,
        owner`DELETE FROM playbooks.step_fallback WHERE step_id IN (SELECT id FROM playbooks.step WHERE playbook_id = ${id})`,
        owner`INSERT INTO playbooks.stage (id, playbook_id, key, ordinal, title, goal, duration_days, exit_criteria)
              VALUES (${randomUUID()}, ${id}, 'late', 99, 't', 'g', 1, 'e')`,
      ]) {
        await expect(attempt).rejects.toThrow(/immutable/);
      }
      const stored = await owner`SELECT title FROM playbooks.playbook WHERE id = ${id}`;
      expect(stored[0]?.title).toBe('Мини-сценарий');
    });

    it('FR-PLAY-03: publishing an unknown id is 404', async () => {
      const error = await refused(inTx((tx) => loader.publish(tx, randomUUID(), NOW)));
      expect([error.status, error.code]).toEqual([404, 'NOT_FOUND']);
    });

    it('FR-PLAY-03: an older draft cannot be published after a higher version of the type', async () => {
      const older = await inTx((tx) =>
        loader.upload(tx, mini('1.0.0', 'order_type'), SYSTEM, roles),
      );
      const newer = await inTx((tx) =>
        loader.upload(tx, mini('1.1.0', 'order_type'), SYSTEM, roles),
      );
      await inTx((tx) => loader.publish(tx, newer.playbook.id, NOW));
      const error = await refused(inTx((tx) => loader.publish(tx, older.playbook.id, NOW)));
      expect([error.status, error.code]).toEqual([409, 'PLAYBOOK_VERSION_NOT_GREATER']);
    });

    it('FR-PLAY-03: two concurrent uploads of one version: exactly one wins, the other is 409', async () => {
      const text = mini('3.0.0', 'race_type');
      const results = await Promise.allSettled([
        inTx((tx) => loader.upload(tx, text, SYSTEM, roles)),
        inTx((tx) => loader.upload(tx, text, SYSTEM, roles)),
        inTx((tx) => loader.upload(tx, text, SYSTEM, roles)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toMatchObject({
            status: 409,
            code: 'PLAYBOOK_VERSION_NOT_GREATER',
          });
        }
      }
      expect(
        (
          await owner`SELECT count(*)::int AS n FROM playbooks.playbook WHERE product_type_code = 'race_type'`
        )[0]?.n,
      ).toBe(1);
    });

    it('CLI path: the same version with other content is refused, with the same content it is a no-op', async () => {
      const text = mini('4.0.0', 'cli_type');
      const options = { uploadedBy: SYSTEM, publish: true, roleCodes: roles, now: NOW };
      expect((await inTx((tx) => loader.ensureLoaded(tx, text, options))).outcome).toBe(
        'published',
      );
      expect((await inTx((tx) => loader.ensureLoaded(tx, text, options))).outcome).toBe(
        'unchanged',
      );
      const changed = text.replace('Мини-сценарий', 'Другое название');
      const error = await refused(inTx((tx) => loader.ensureLoaded(tx, changed, options)));
      expect([error.status, error.code]).toEqual([409, 'PLAYBOOK_VERSION_NOT_GREATER']);
    });

    it('CLI path: a draft loaded without --publish is published by a later run with --publish', async () => {
      const text = mini('5.0.0', 'cli_draft_type');
      const base = { uploadedBy: SYSTEM, roleCodes: roles, now: NOW };
      expect(
        (await inTx((tx) => loader.ensureLoaded(tx, text, { ...base, publish: false }))).outcome,
      ).toBe('created');
      const second = await inTx((tx) => loader.ensureLoaded(tx, text, { ...base, publish: true }));
      expect([second.outcome, second.playbook.status]).toEqual(['published', 'published']);
    });
  });

  describe('reading (S5-03)', () => {
    const policies = new ActorPolicies();
    const adminId = randomUUID();
    policies.register('admin', {
      requiresSession: true,
      check: ({ userId }) => {
        if (userId !== adminId) throw new DomainError('ADMIN_ONLY', 403);
      },
    });
    let service: PlaybookReadService;

    beforeAll(() => {
      service = new PlaybookReadService(new PlaybookReader(db), new AdminProbe(policies));
    });

    it('FR-PLAY-03: the public list holds published playbooks only; the admin list holds drafts too', async () => {
      const draft = await inTx((tx) =>
        loader.upload(tx, mini('9.9.0', 'list_type'), SYSTEM, roles),
      );
      const published = await service.list({ productType: 'list_type', limit: 100 }, false);
      expect(published.items).toEqual([]);
      const all = await service.list({ productType: 'list_type', limit: 100 }, true);
      expect(all.items.map((p) => [p.id, p.status])).toEqual([[draft.playbook.id, 'draft']]);
    });

    it('FR-PLAY-05: pages by keyset (type, then newest version first) without gaps or repeats', async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await service.list({ limit: 3, cursor }, true);
        seen.push(...page.items.map((p) => `${p.productTypeCode}@${p.version}`));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined && pages < 50);
      const total = (await owner`SELECT count(*)::int AS n FROM playbooks.playbook`)[0]
        ?.n as number;
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
      expect(pages).toBeGreaterThan(2);
      const web = seen.filter((s) => s.startsWith('web_service@'));
      expect(web[0]).toBe('web_service@9.1.0');
      expect(web.at(-1)).toBe('web_service@0.0.1');
    });

    it('FR-PLAY-03: a cursor made for other filters is refused with 400', async () => {
      const page = await service.list({ limit: 1 }, true);
      expect(page.nextCursor).not.toBeNull();
      const error = await refused(
        service.list({ limit: 1, cursor: page.nextCursor ?? '', productType: 'web_service' }, true),
      );
      expect(error.status).toBe(400);
    });

    it('FR-PLAY-01: getPlaybook shows stages, steps, review items and fallbacks; a draft is 404 for users, open to admins', async () => {
      const draft = await inTx((tx) =>
        loader.upload(tx, mini('9.9.1', 'list_type'), SYSTEM, roles),
      );
      const user = randomUUID();
      expect((await refused(service.get(draft.playbook.id, user))).status).toBe(404);
      const asAdmin = await service.get(draft.playbook.id, adminId);
      expect(asAdmin.status).toBe('draft');
      expect(asAdmin.stages.map((s) => s.key)).toEqual(['mini_s1', 'mini_s2', 'mini_s3']);
      const charter = asAdmin.stages[0]?.steps.find((s) => s.key === 'mini_charter');
      expect(charter?.fallback).toMatchObject({ template: 'tpl_charter' });
      expect(charter?.sources.length).toBeGreaterThan(0);
      const rows =
        await owner`SELECT id FROM playbooks.playbook WHERE product_type_code = 'web_service' AND version = '1.0.0'`;
      const web = rows[0]?.id as string;
      const full = await service.get(web, user);
      expect(full.stages).toHaveLength(8);
      expect(full.stages[0]?.steps).toHaveLength(6);
      expect((await refused(service.get(randomUUID(), user))).status).toBe(404);
    });

    it('FR-WORK-02: getTemplate answers the latest version of a platform template; unknown key is 404', async () => {
      const first = await service.getTemplate('tpl_adr');
      expect(first).toMatchObject({ key: 'tpl_adr', version: 1, title: 'ADR' });
      expect(first.bodyMd).toContain('## Контекст');
      await owner`INSERT INTO playbooks.platform_template (key, version, title, body_md) VALUES ('tpl_adr', 2, 'ADR v2', '# v2')`;
      expect(await service.getTemplate('tpl_adr')).toMatchObject({ version: 2, title: 'ADR v2' });
      expect((await refused(service.getTemplate('tpl_unknown'))).status).toBe(404);
    });
  });

  describe('platform templates (docs/playbooks.md section 5.1)', () => {
    it('every fallback template of both real playbooks is in the catalog, version 1', async () => {
      const missing = await owner`
        SELECT DISTINCT f.template_key FROM playbooks.step_fallback f
         WHERE NOT EXISTS (SELECT 1 FROM playbooks.platform_template t WHERE t.key = f.template_key)`;
      expect(missing).toEqual([]);
      const count =
        await owner`SELECT count(*)::int AS n FROM playbooks.platform_template WHERE version = 1`;
      expect(count[0]?.n).toBe(35);
    });
  });
});
