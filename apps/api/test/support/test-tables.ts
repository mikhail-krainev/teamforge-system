import postgres from 'postgres';

/**
 * Probe tables used by TestSupportController. Created through the DIRECT, owner connection: the
 * application role may not run DDL (S1R-10). Called once for the migrated template database.
 */
export async function createTestTables(owner: postgres.Sql): Promise<void> {
  await owner.unsafe(`CREATE TABLE IF NOT EXISTS public.tf_test_effect (
    id bigserial PRIMARY KEY, value text NOT NULL)`);
  await owner.unsafe(`CREATE TABLE IF NOT EXISTS public.tf_test_versioned (
    id uuid PRIMARY KEY, version int NOT NULL DEFAULT 1, value text NOT NULL)`);
  await owner.unsafe(`CREATE TABLE IF NOT EXISTS public.tf_test_account (
    id bigserial PRIMARY KEY, email text NOT NULL, token text NOT NULL,
    CONSTRAINT tf_test_account_email_uq UNIQUE (email))`);
}
