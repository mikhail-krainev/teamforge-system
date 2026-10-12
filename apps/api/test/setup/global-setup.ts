import postgres from 'postgres';
import { runMigrations } from '../../src/platform/db/migrate.js';
import { createTestTables } from '../support/test-tables.js';
import { databaseUrlFor, TEMPLATE_DB } from '../helpers/db-url.js';

/**
 * Vitest globalSetup: applies Drizzle migrations ONCE through the direct connection
 * (DATABASE_DIRECT_URL, bypassing PgBouncer) into the template database `tf_template`.
 * Every integration test file then clones its own database from it (test/helpers/infra.ts).
 * Without DATABASE_DIRECT_URL only unit tests run, and this says so explicitly.
 */
export default async function setup(): Promise<void> {
  const directUrl = process.env.DATABASE_DIRECT_URL;
  if (directUrl === undefined || directUrl === '') {
    process.stderr.write(
      '[tf-test] DATABASE_DIRECT_URL is not set: integration tests (PostgreSQL) are SKIPPED. ' +
        'Set DATABASE_URL, DATABASE_DIRECT_URL and REDIS_URL to run them (CI does).\n',
    );
    return;
  }
  const admin = postgres(directUrl, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const templateUrl = databaseUrlFor(directUrl, TEMPLATE_DB);
  await runMigrations(templateUrl);
  // Probe tables of the test-support controller; DDL needs the owner role, not the application role.
  const owner = postgres(templateUrl, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    await createTestTables(owner);
  } finally {
    await owner.end({ timeout: 5 });
  }
}
