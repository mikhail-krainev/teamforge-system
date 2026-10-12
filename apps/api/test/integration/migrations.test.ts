import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations } from '../../src/platform/db/migrate.js';
import { createTestDatabase, describeInfra, type TestDatabase } from '../helpers/infra.js';

describeInfra('S1-04 migrations (direct connection)', ['db'], () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('creates the nine schemas and the four platform tables', async () => {
    const schemas = await db.sql`SELECT schema_name FROM information_schema.schemata
      WHERE schema_name = ANY(${[
        'platform',
        'auth',
        'profiles',
        'playbooks',
        'teams',
        'matching',
        'workspace',
        'github',
        'rewards',
      ]})`;
    expect(schemas).toHaveLength(9);
    const tables = await db.sql`SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'platform' AND table_name <> '__drizzle_migrations' ORDER BY table_name`;
    expect(tables.map((t) => t.table_name)).toEqual([
      'event_dead_letter',
      'idempotency_key',
      'inbox_event',
      'outbox_event',
    ]);
  });

  it('creates the partial and plain indexes of architecture 5.1', async () => {
    const indexes =
      await db.sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'platform' ORDER BY indexname`;
    expect(indexes.map((i) => i.indexname)).toEqual(
      expect.arrayContaining([
        'event_dead_letter_open_idx',
        'idempotency_key_expires_idx',
        'outbox_published_at_idx',
        'outbox_unpublished_idx',
      ]),
    );
  });

  it('is idempotent: a repeated run changes nothing', async () => {
    const before = await db.sql`SELECT count(*)::int AS n FROM platform.__drizzle_migrations`;
    await runMigrations(db.directUrl);
    await runMigrations(db.directUrl);
    const after = await db.sql`SELECT count(*)::int AS n FROM platform.__drizzle_migrations`;
    expect(after[0]?.n).toBe(before[0]?.n);
    expect(after[0]?.n).toBe(before[0]?.n);
    expect(after[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it('enforces idempotency_key status values', async () => {
    await expect(
      db.sql`INSERT INTO platform.idempotency_key
        (user_id, key, operation_id, request_hash, status, locked_until, lock_token, created_at, expires_at)
        VALUES (gen_random_uuid(), gen_random_uuid(), 'x', ${Buffer.from('h')}, 'bogus', now(),
                gen_random_uuid(), now(), now())`,
    ).rejects.toThrow(/idempotency_key_status_check/);
  });

  it('S1R-10: the application role is no superuser, has DML on platform tables and no DDL', async () => {
    const app = postgres(db.url, { max: 1, prepare: false, onnotice: () => undefined });
    try {
      const role = await app`SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole
        FROM pg_roles WHERE rolname = current_user`;
      expect(role[0]).toMatchObject({
        name: 'tf_app',
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
      });
      const id = crypto.randomUUID();
      await app`INSERT INTO platform.inbox_event (consumer, event_id, processed_at)
        VALUES ('role-test', ${id}, now())`;
      await app`DELETE FROM platform.inbox_event WHERE event_id = ${id}`;
      await expect(app.unsafe('CREATE TABLE public.tf_forbidden (id int)')).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.unsafe('CREATE TABLE platform.tf_forbidden (id int)')).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.unsafe('CREATE SCHEMA tf_forbidden')).rejects.toThrow(/permission denied/);
      await expect(app.unsafe('DROP TABLE platform.outbox_event')).rejects.toThrow(/must be owner/);
      await expect(app.unsafe("COPY (SELECT 1) TO PROGRAM 'true'")).rejects.toThrow(
        /permission denied|superuser/,
      );
    } finally {
      await app.end({ timeout: 5 });
    }
  });

  it('S1R-10: migrations are owned by the migrator role, not by the application role', async () => {
    const owners =
      await db.sql`SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'platform'`;
    expect(owners.map((o) => o.tableowner)).toEqual(['tf_migrator']);
  });
});
