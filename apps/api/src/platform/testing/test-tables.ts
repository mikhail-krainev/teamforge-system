import { sql } from 'drizzle-orm';
import type { Database } from '../db/db.module.js';

/** Creates the probe tables used by TestSupportController in a test database. */
export async function createTestTables(db: Database): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS public.tf_test_effect (
    id bigserial PRIMARY KEY, value text NOT NULL)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS public.tf_test_versioned (
    id uuid PRIMARY KEY, version int NOT NULL DEFAULT 1, value text NOT NULL)`);
}
