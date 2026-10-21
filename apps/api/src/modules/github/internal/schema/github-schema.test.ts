import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { databaseUrlFor } from '../../../../../test/helpers/db-url.js';
import { describeInfra } from '../../../../../test/helpers/infra.js';
import { runMigrations } from '../../../../platform/db/migrate.js';

const quiet = { prepare: false, onnotice: () => undefined } as const;
const now = new Date('2026-10-18T10:00:00Z');

/**
 * S6-03: migration 0015 applied to an EMPTY database: the tables of the github schema, the partial
 * unique indexes of CC-9 and CC-11, the immutable snapshot of a completed project (CC-13) and the
 * rights of the application role (DML only).
 */
describeInfra('S6-03 github and slice 6 workspace schema from a clean database', ['db'], () => {
  const dbName = `tf_s6_schema_check_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const adminUrl = process.env.DATABASE_DIRECT_URL ?? '';
  let appUrl = '';
  let sql: postgres.Sql;

  beforeAll(async () => {
    const admin = postgres(adminUrl, { max: 1, ...quiet });
    try {
      await admin.unsafe(`CREATE DATABASE ${dbName}`);
    } finally {
      await admin.end({ timeout: 5 });
    }
    const directUrl = databaseUrlFor(adminUrl, dbName);
    appUrl = databaseUrlFor(process.env.DATABASE_URL ?? '', dbName);
    await runMigrations(directUrl);
    sql = postgres(directUrl, { max: 2, ...quiet });
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    const admin = postgres(adminUrl, { max: 1, ...quiet });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });

  it('creates the nine tables of the github schema', async () => {
    const rows = await sql`SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'github' AND table_type = 'BASE TABLE' ORDER BY table_name`;
    expect(rows.map((r) => String(r.table_name))).toEqual([
      'account_check',
      'gh_installation',
      'gh_item',
      'gh_pr_review',
      'installation_grant',
      'repo_check',
      'repo_link',
      'repo_sync_state',
      'webhook_delivery',
    ]);
  });

  it('creates the partial unique indexes: one holder per repository, one active link per team, one contribution per source', async () => {
    const rows = await sql`SELECT indexname, indexdef FROM pg_indexes
      WHERE indexname IN ('repo_link_repository_uq', 'repo_link_team_active_uq', 'contribution_uq')`;
    const byName = Object.fromEntries(rows.map((r) => [String(r.indexname), String(r.indexdef)]));
    expect(byName['repo_link_repository_uq']).toMatch(
      /UNIQUE .*\(repository_id\) WHERE .*active.*completed/s,
    );
    expect(byName['repo_link_team_active_uq']).toMatch(/UNIQUE .*\(team_id\) WHERE .*active/s);
    expect(byName['contribution_uq']).toMatch(/UNIQUE .*\(team_id, source, ref, user_id\)/);
  });

  it('CC-13: a completion row is written once and its snapshot never changes', async () => {
    const teamId = randomUUID();
    await sql`INSERT INTO workspace.project_completion
      (team_id, completed_at, planned_end_at, overdue_days, snapshot, completed_by)
      VALUES (${teamId}, ${now}, ${now}, 0, '{"members":[]}'::jsonb, ${randomUUID()})`;
    await expect(
      sql`INSERT INTO workspace.project_completion
        (team_id, completed_at, planned_end_at, overdue_days, snapshot, completed_by)
        VALUES (${teamId}, ${now}, ${now}, 0, '{}'::jsonb, ${randomUUID()})`,
    ).rejects.toThrow(/project_completion_pkey/);
    await expect(
      sql`UPDATE workspace.project_completion SET snapshot = '{"members":["x"]}'::jsonb WHERE team_id = ${teamId}`,
    ).rejects.toThrow(/immutable/);
    const [row] =
      await sql`SELECT snapshot FROM workspace.project_completion WHERE team_id = ${teamId}`;
    expect(row?.['snapshot']).toEqual({ members: [] });
  });

  it('lets the application role do DML on the new tables and no DDL', async () => {
    const app = postgres(appUrl, { max: 1, ...quiet });
    try {
      const installationId = 4242;
      await app`INSERT INTO github.gh_installation (installation_id, account_id, account_login, account_type, status, updated_at)
        VALUES (${installationId}, 1, 'octo', 'User', 'active', ${now})`;
      await app`INSERT INTO github.installation_grant (installation_id, team_id, user_id, granted_at)
        VALUES (${installationId}, ${randomUUID()}, ${randomUUID()}, ${now})`;
      await app`UPDATE github.gh_installation SET status = 'suspended' WHERE installation_id = ${installationId}`;
      await expect(app`CREATE TABLE github.rogue (id int)`).rejects.toThrow(/permission denied/);
    } finally {
      await app.end({ timeout: 5 });
    }
  });
});
