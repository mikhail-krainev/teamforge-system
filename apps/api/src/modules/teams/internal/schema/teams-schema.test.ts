import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../../platform/db/migrate.js';
import { databaseUrlFor } from '../../../../../test/helpers/db-url.js';
import { describeInfra } from '../../../../../test/helpers/infra.js';

const TEAMS_TABLES = [
  'departure',
  'invitation',
  'leader_vote',
  'membership',
  'seat',
  'seat_assignment',
  'seat_offer',
  'team',
  'team_event',
  'vote_ballot',
  'vote_candidate',
  'vote_eligible',
  'vote_offer',
  'vote_request',
];

const quiet = { prepare: false, onnotice: () => undefined } as const;

/**
 * S3-02: all migrations applied to an EMPTY database (not the shared template), then the schema of
 * slice 3 is inspected. A private database keeps this independent of other test files.
 */
describeInfra('S3-02 teams schema from a clean database', ['db'], () => {
  const dbName = `tf_s3_schema_check_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const adminUrl = process.env.DATABASE_DIRECT_URL ?? '';
  let directUrl = '';
  let appUrl = '';
  let sql: postgres.Sql;

  beforeAll(async () => {
    const admin = postgres(adminUrl, { max: 1, ...quiet });
    try {
      await admin.unsafe(`CREATE DATABASE ${dbName}`);
    } finally {
      await admin.end({ timeout: 5 });
    }
    directUrl = databaseUrlFor(adminUrl, dbName);
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

  const tablesOf = async (schema: string): Promise<string[]> => {
    const rows = await sql`SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_type = 'BASE TABLE' ORDER BY table_name`;
    return rows.map((r) => String(r.table_name));
  };

  it('creates the fourteen teams tables, the playbooks minimum and the notification', async () => {
    expect(await tablesOf('teams')).toEqual(TEAMS_TABLES);
    expect(await tablesOf('playbooks')).toEqual(['playbook', 'product_type']);
    expect(await tablesOf('workspace')).toEqual(['notification']);
  });

  it('creates the partial unique indexes with their predicates (CC-1, CC-4, FR-TEAM-07)', async () => {
    const rows = await sql`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'teams'
      AND indexname IN ('seat_assignment_active_seat_uq', 'seat_assignment_active_role_uq',
        'membership_active_uq', 'leader_vote_open_uq', 'seat_offer_pending_uq', 'vote_offer_pending_uq')`;
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(String(row.indexdef)).toMatch(/CREATE UNIQUE INDEX .* WHERE /);
    }
  });

  it('creates the architecture 5.10 indexes', async () => {
    const rows = await sql`SELECT indexname FROM pg_indexes
      WHERE schemaname IN ('teams', 'workspace') ORDER BY indexname`;
    expect(rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining([
        'team_catalog_idx',
        'seat_open_role_idx',
        'seat_team_status_role_idx',
        'membership_user_status_idx',
        'membership_trial_idx',
        'leader_vote_deadline_idx',
        'departure_pending_idx',
        'team_event_team_idx',
        'notification_dedupe_uq',
        'notification_user_idx',
      ]),
    );
  });

  it('seeds the two active product types and published stub playbooks 0.0.1', async () => {
    const types = await sql`SELECT code, active FROM playbooks.product_type ORDER BY code`;
    expect(types.map((t) => [t.code, t.active])).toEqual([
      ['ml_product', true],
      ['web_service', true],
    ]);
    const books = await sql`SELECT product_type_code, version, status, total_days
      FROM playbooks.playbook ORDER BY product_type_code`;
    expect(books.map((b) => [b.product_type_code, b.version, b.status, b.total_days])).toEqual([
      ['ml_product', '0.0.1', 'published', 91],
      ['web_service', '0.0.1', 'published', 84],
    ]);
  });

  it('is idempotent: running the migrations again changes nothing', async () => {
    await runMigrations(directUrl);
    const books = await sql`SELECT count(*)::int AS n FROM playbooks.playbook`;
    expect(books[0]?.n).toBe(2);
  });

  describe('invariants enforced by the database', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const insertTeam = async (): Promise<string> => {
      const id = randomUUID();
      await sql`INSERT INTO teams.team (id, name, description, product_type_code, playbook_id,
        status, timezone, hours_per_week, created_by, created_at, updated_at)
        VALUES (${id}, 't', 'd', 'web_service', ${randomUUID()}, 'forming', 'UTC', 10,
          ${randomUUID()}, ${now}, ${now})`;
      return id;
    };

    it('CC-4: a second open leader vote for a team is rejected, a closed one is not', async () => {
      const teamId = await insertTeam();
      const vote = (status: string) => sql`INSERT INTO teams.leader_vote
        (id, team_id, trigger, status, opened_at, voting_deadline, eligible_count)
        VALUES (${randomUUID()}, ${teamId}, 'lead_left', ${status}, ${now}, ${now}, 3)`;
      await vote('nominating');
      await expect(vote('voting')).rejects.toThrow(/leader_vote_open_uq/);
      await vote('closed');
    });

    it('rejects a member_count above 8 and an unknown team status', async () => {
      const teamId = await insertTeam();
      await expect(
        sql`UPDATE teams.team SET member_count = 9 WHERE id = ${teamId}`,
      ).rejects.toThrow(/team_member_count_check/);
      await expect(sql`UPDATE teams.team SET status = 'bogus' WHERE id = ${teamId}`).rejects.toThrow(
        /team_status_check/,
      );
    });

    it('lets the application role do DML on the new tables and no DDL', async () => {
      const app = postgres(appUrl, { max: 1, ...quiet });
      try {
        const rows = await app`SELECT code FROM playbooks.product_type ORDER BY code`;
        expect(rows).toHaveLength(2);
        await app`INSERT INTO workspace.notification (id, user_id, type, payload, dedupe_key, created_at)
          VALUES (${randomUUID()}, ${randomUUID()}, 'x', '{}'::jsonb, ${randomUUID()}, ${now})`;
        await expect(app`CREATE TABLE teams.rogue (id int)`).rejects.toThrow(/permission denied/);
      } finally {
        await app.end({ timeout: 5 });
      }
    });
  });
});
