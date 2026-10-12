import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { loadMigrateConfigOrExit } from '../config/config.js';

export const MIGRATIONS_FOLDER = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../drizzle',
);

/** Applies all pending migrations over a DIRECT connection (never through PgBouncer). */
export async function runMigrations(
  directUrl: string,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  const client = postgres(directUrl, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    await migrate(drizzle(client), {
      migrationsFolder,
      migrationsSchema: 'platform',
      migrationsTable: '__drizzle_migrations',
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const { DATABASE_DIRECT_URL } = loadMigrateConfigOrExit(process.env);
  await runMigrations(DATABASE_DIRECT_URL);
  process.stdout.write('migrations applied\n');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    process.stderr.write(`migration failed: ${message}\n`);
    process.exit(1);
  });
}
