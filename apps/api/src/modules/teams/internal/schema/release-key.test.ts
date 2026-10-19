import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { databaseUrlFor } from '../../../../../test/helpers/db-url.js';
import { describeInfra } from '../../../../../test/helpers/infra.js';
import { MIGRATIONS_FOLDER, runMigrations } from '../../../../platform/db/migrate.js';

const quiet = { prepare: false, onnotice: () => undefined } as const;
const now = new Date('2026-10-18T10:00:00Z');
/** Migration 0017 adds `team.release_key`; the folder below stops before it. */
const RELEASE_KEY_MIGRATION = '0017_release_key_resume_cursor_team_index';

/** The migrations up to the one before 0017, in a private copy of the folder. */
function migrationsBefore(tag: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'tf-migrations-'));
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.tag < tag);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

/**
 * S6SEC-03, AF-02: the key of a release address is made by the database (`teams.release_address_key`,
 * the trigger `team_release_key_trg`) and filled in for the teams that existed before migration 0017.
 */
describeInfra('AF-02 normalized release address (migration 0017)', ['db'], () => {
  const dbName = `tf_release_key_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const adminUrl = process.env.DATABASE_DIRECT_URL ?? '';
  let directUrl = '';
  let sql: postgres.Sql;
  const oldTeams = { plain: randomUUID(), decorated: randomUUID(), empty: randomUUID() };
  let oldMigrations = '';

  const insertTeam = async (releaseUrl: string | null, id = randomUUID()): Promise<string> => {
    await sql`INSERT INTO teams.team (id, name, description, product_type_code, playbook_id,
      status, timezone, hours_per_week, created_by, created_at, updated_at, release_url)
      VALUES (${id}, 't', 'd', 'web_service', ${randomUUID()}, 'forming', 'UTC', 10,
        ${randomUUID()}, ${now}, ${now}, ${releaseUrl})`;
    return id;
  };

  const keyOf = async (address: string | null): Promise<string | null> => {
    const [row] = await sql<
      { key: string | null }[]
    >`SELECT teams.release_address_key(${address}) AS key`;
    return row?.key ?? null;
  };

  beforeAll(async () => {
    const admin = postgres(adminUrl, { max: 1, ...quiet });
    try {
      await admin.unsafe(`CREATE DATABASE ${dbName}`);
    } finally {
      await admin.end({ timeout: 5 });
    }
    directUrl = databaseUrlFor(adminUrl, dbName);
    oldMigrations = migrationsBefore(RELEASE_KEY_MIGRATION);
    await runMigrations(directUrl, oldMigrations);
    sql = postgres(directUrl, { max: 2, ...quiet });
    // Teams of the time before the column existed.
    await insertTeam('https://WWW.Old.Example.test/App/index.html?x=1#y', oldTeams.plain);
    await insertTeam('http://user@old2.example.test:8080/%61pp/', oldTeams.decorated);
    await insertTeam(null, oldTeams.empty);
    await runMigrations(directUrl);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    rmSync(oldMigrations, { recursive: true, force: true });
    const admin = postgres(adminUrl, { max: 1, ...quiet });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });

  it('the migration fills the key of teams that already had an address', async () => {
    const rows = await sql<{ id: string; release_key: string | null }[]>`
      SELECT id, release_key FROM teams.team WHERE id IN ${sql(Object.values(oldTeams))}`;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.release_key]));
    expect(byId[oldTeams.plain]).toBe('old.example.test/app');
    expect(byId[oldTeams.decorated]).toBe('old2.example.test/app');
    expect(byId[oldTeams.empty]).toBeNull();
  });

  it.each([
    ['https://foo.app/', 'foo.app'],
    ['https://foo.app', 'foo.app'],
    ['HTTP://FOO.App./', 'foo.app'],
    ['https://www.foo.app/', 'foo.app'],
    ['https://WWW.foo.app/x', 'foo.app/x'],
    ['https://foo.app/index.html', 'foo.app'],
    ['https://foo.app/x/index.html', 'foo.app/x'],
    ['https://foo.app/x/index.htm/', 'foo.app/x'],
    ['https://foo.app/?utm_source=a#top', 'foo.app'],
    ['https://foo.app/Docs//Guide///', 'foo.app/docs/guide'],
    ['https://foo.app/%61pp', 'foo.app/app'],
    ['https://foo.app/%41pp/%7Euser', 'foo.app/app/~user'],
    ['https://foo.app/%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82', 'foo.app/привет'],
    ['https://foo.app/%E0%A4%A', 'foo.app/%e0%a4%a'],
    ['https://foo.app/a/./b/../c', 'foo.app/a/c'],
    ['https://foo.app/a/%2e%2e/b', 'foo.app/b'],
    ['https://foo.app/../..', 'foo.app'],
    ['https://user:pass@foo.app:8443/x', 'foo.app/x'],
    ['https:\\\\foo.app\\x', 'foo.app/x'],
    ['https://foo.app/x\t\n', 'foo.app/x'],
    ['https://www.app.foo.app/x', 'app.foo.app/x'],
  ])('the key of %s is %s', async (address, key) => {
    expect(await keyOf(address)).toBe(key);
  });

  it.each(['not an address', '', '::::', 'foo.app/x', 'https:///x', null])(
    'text that is no address has no key: %s',
    async (address) => {
      expect(await keyOf(address)).toBeNull();
    },
  );

  it('different hosts or paths stay different keys', async () => {
    const keys = await Promise.all(
      ['https://foo.app/a', 'https://foo.app/b', 'https://bar.app/a', 'https://app.foo.app/a'].map(
        keyOf,
      ),
    );
    expect(new Set(keys).size).toBe(4);
  });

  it('the trigger keeps the key right on insert, on a new address and on removing the address', async () => {
    const id = await insertTeam('https://www.Trigger.test/Path/');
    const read = async (): Promise<string | null> =>
      (
        await sql<
          { release_key: string | null }[]
        >`SELECT release_key FROM teams.team WHERE id = ${id}`
      )[0]?.release_key ?? null;
    expect(await read()).toBe('trigger.test/path');
    await sql`UPDATE teams.team SET release_url = 'https://other.test/index.html' WHERE id = ${id}`;
    expect(await read()).toBe('other.test');
    await sql`UPDATE teams.team SET release_url = NULL WHERE id = ${id}`;
    expect(await read()).toBeNull();
  });

  it('the key is indexed', async () => {
    const rows =
      await sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'team_release_key_idx'`;
    expect(rows).toHaveLength(1);
    const repoLink = await sql`SELECT 1 FROM pg_indexes WHERE indexname = 'repo_link_team_idx'`;
    expect(repoLink).toHaveLength(1);
  });
});
