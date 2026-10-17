import { defineConfig } from 'drizzle-kit';

// Generation works offline. `migrate` uses the DIRECT connection (bypasses PgBouncer, Р-18).
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/platform/db/schema/*.ts', './src/modules/*/internal/schema/!(*.test).ts'],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_DIRECT_URL ?? '' },
  migrations: { schema: 'platform', table: '__drizzle_migrations' },
  strict: true,
  verbose: true,
});
