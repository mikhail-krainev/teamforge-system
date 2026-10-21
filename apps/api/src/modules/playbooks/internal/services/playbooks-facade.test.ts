import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { databaseUrlFor } from '../../../../../test/helpers/db-url.js';
import { describeInfra } from '../../../../../test/helpers/infra.js';
import type { Database } from '../../../../platform/db/db.module.js';
import { runMigrations } from '../../../../platform/db/migrate.js';
import type { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { PlaybookDefinitions } from '../read/playbook-definitions.js';
import { PlaybookReader } from '../read/playbook-reader.js';
import { PlaybooksFacade } from './playbooks-facade.service.js';

describeInfra('S3-02 PlaybooksApi (seeded stubs)', ['db'], () => {
  const quiet = { prepare: false, onnotice: () => undefined } as const;
  const dbName = `tf_s3_playbooks_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const adminUrl = process.env.DATABASE_DIRECT_URL ?? '';
  let sql: postgres.Sql;
  let app: postgres.Sql;
  let facade: PlaybooksFacade;
  const testDb = {
    get sql() {
      return sql;
    },
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
    sql = postgres(directUrl, { max: 2, ...quiet });
    app = postgres(databaseUrlFor(process.env.DATABASE_URL ?? '', dbName), { max: 2, ...quiet });
    const db = drizzle(app) as unknown as Database;
    const tx = { tx: db } as unknown as TxRunner;
    facade = new PlaybooksFacade(tx, new PlaybookDefinitions(new PlaybookReader(tx)));
  });

  afterAll(async () => {
    await app.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
    const admin = postgres(adminUrl, { max: 1, ...quiet });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });

  it('FR-PLAY-06: lists the two active product types, ordered by code', async () => {
    const types = await facade.listProductTypes();
    expect(types.map((t) => [t.code, t.active])).toEqual([
      ['ml_product', true],
      ['web_service', true],
    ]);
  });

  it('activeOnly hides inactive types', async () => {
    await testDb.sql`INSERT INTO playbooks.product_type (code, name, active) VALUES ('mobile_app', 'Mobile', false)`;
    expect((await facade.listProductTypes()).map((t) => t.code)).toContain('mobile_app');
    expect((await facade.listProductTypes({ activeOnly: true })).map((t) => t.code)).toEqual([
      'ml_product',
      'web_service',
    ]);
  });

  it('getLatestPublished returns the stub 0.0.1 for a seeded type', async () => {
    const latest = await facade.getLatestPublished('web_service');
    expect(latest).toMatchObject({ version: '0.0.1', totalDays: 84 });
    expect(await facade.getLatestPublished('ml_product')).toMatchObject({ totalDays: 91 });
  });

  it('getLatestPublished picks the highest semver and ignores drafts', async () => {
    const insert = (version: string, major: number, minor: number, patch: number, status: string) =>
      testDb.sql`INSERT INTO playbooks.playbook (id, product_type_code, title, version, v_major,
        v_minor, v_patch, status, total_days, source_text, source_sha256, uploaded_by)
        VALUES (${randomUUID()}, 'ml_product', 't', ${version}, ${major}, ${minor}, ${patch},
        ${status}, 10, 's', ${Buffer.from('x')}, ${randomUUID()})`;
    await insert('0.10.0', 0, 10, 0, 'published');
    await insert('0.9.0', 0, 9, 0, 'published');
    await insert('2.0.0', 2, 0, 0, 'draft');
    expect((await facade.getLatestPublished('ml_product'))?.version).toBe('0.10.0');
  });

  it('getLatestPublished is null for an unknown type', async () => {
    expect(await facade.getLatestPublished('nope')).toBeNull();
  });
});
