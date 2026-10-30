#!/usr/bin/env node
// Demo data for the local run (docs/local-run.md, "Демо-данные"): `pnpm seed:demo`.
// Deletes the previous demo rows and writes a fresh set: ~60 people, about twenty projects on every stage,
// the queue, offers, trials, GitHub work, credits, reviews and anti-fraud cases. Local databases only.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { MAX_FOREIGN_USERS, databaseUrl, loadEnv, productionRefusal } from './env.mjs';
import { DEMO_ACCOUNTS, PEOPLE } from './people.mjs';
import { TEAMS } from './teams.mjs';
import { GITHUB_ID_BASE, ID_PREFIX, World } from './world.mjs';
import { buildPeople } from './build-people.mjs';
import { buildTeam } from './build-teams.mjs';
import { buildWork } from './build-work.mjs';
import { buildResults, buildRewards } from './build-results.mjs';
import {
  buildCandidateStats,
  buildInstallation,
  buildNotifications,
  buildQueue,
  buildRecommendations,
  buildVote,
} from './build-social.mjs';

const apiRoot = path.resolve(import.meta.dirname, '../..');
const repoRoot = path.resolve(apiRoot, '../..');
const postgres = createRequire(path.join(apiRoot, 'package.json'))('postgres');
const SCHEMAS = ['auth', 'profiles', 'teams', 'matching', 'workspace', 'github', 'rewards'];

/** The newest published playbook per product type, with steps and the size of their review checklists. */
async function loadPlaybooks(sql) {
  const books = await sql`
    select distinct on (product_type_code) id, product_type_code from playbooks.playbook
    where status = 'published' order by product_type_code, id desc`;
  const result = {};
  for (const book of books) {
    const stages =
      await sql`select id, key, ordinal, title, duration_days from playbooks.stage where playbook_id = ${book.id} order by ordinal`;
    const steps = await sql`
      select s.stage_id, s.key, s.ordinal, s.title, s.kind, s.submission, s.ritual_kind, s.required, s.owner_role, s.alt_roles,
             (select count(*)::int from playbooks.step_review_item r where r.step_id = s.id) as review_items
      from playbooks.step s where s.playbook_id = ${book.id} order by s.ordinal`;
    result[book.product_type_code] = {
      id: book.id,
      stages: stages.map((st) => ({
        key: st.key,
        ordinal: st.ordinal,
        title: st.title,
        durationDays: st.duration_days,
        steps: steps
          .filter((s) => s.stage_id === st.id)
          .map((s) => ({
            key: s.key,
            title: s.title,
            kind: s.kind,
            submission: s.submission,
            ritualKind: s.ritual_kind,
            required: s.required,
            ownerRole: s.owner_role,
            altRoles: s.alt_roles,
            reviewItems: s.review_items,
          })),
      })),
    };
  }
  for (const type of ['web_service', 'ml_product']) {
    if (!result[type]?.stages.length)
      throw new Error(
        `No published ${type} playbook: start the local stack first (migrate loads them)`,
      );
  }
  return result;
}

function currentConsent() {
  const dir = path.join(apiRoot, 'seeds/consent');
  const newest = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .at(-1);
  const latest = JSON.parse(readFileSync(path.join(dir, newest), 'utf8'));
  return {
    version: latest.version,
    textHash: createHash('sha256').update(latest.text, 'utf8').digest(),
  };
}

/** Every row whose uuid columns hold a demo id, plus demo GitHub numbers; triggers are off for the session. */
async function wipe(sql) {
  const columns = await sql`
    select table_schema, table_name, column_name, data_type from information_schema.columns
    where table_schema in ${sql(SCHEMAS)} and data_type in ('uuid', 'bigint')
      and table_name in (select table_name from information_schema.tables where table_type = 'BASE TABLE' and table_schema = columns.table_schema)`;
  const byTable = Map.groupBy(columns, (c) => `${c.table_schema}.${c.table_name}`);
  let deleted = 0;
  for (const [table, cols] of byTable) {
    const conditions = cols.map((c) =>
      c.data_type === 'uuid'
        ? sql`${sql(c.column_name)}::text like ${`${ID_PREFIX}-%`}`
        : sql`${sql(c.column_name)} >= ${GITHUB_ID_BASE}`,
    );
    const where = conditions.reduce((acc, c) => sql`${acc} or ${c}`);
    const result = await sql`delete from ${sql(table)} where ${where}`;
    deleted += result.count;
  }
  return deleted;
}

/** Inserts in chunks; rows of one table may leave optional columns out (filled with null). */
async function insertAll(sql, rows) {
  for (const [table, list] of Object.entries(rows)) {
    const keys = [...new Set(list.flatMap((r) => Object.keys(r)))];
    const normalized = list.map((r) => Object.fromEntries(keys.map((k) => [k, r[k] ?? null])));
    for (let i = 0; i < normalized.length; i += 500) {
      await sql`insert into ${sql(table)} ${sql(normalized.slice(i, i + 500), keys)}`;
    }
  }
}

const JSON_COLUMNS = new Set([
  'strengths',
  'weaknesses',
  'payload',
  'reasons',
  'snapshot',
  'data',
  'results',
  'counts',
]);

function build(playbooks) {
  const world = new World(new Date());
  buildPeople(world, PEOPLE, currentConsent());
  buildInstallation(world);
  const admin = world.person('demo-admin');
  const teams = TEAMS.map((bp) => buildTeam(world, bp, playbooks[bp.type]));
  for (const team of teams) {
    buildWork(world, team);
    buildResults(world, team, admin);
    if (team.bp.status === 'voting') buildVote(world, team);
  }
  buildRewards(world);
  buildCandidateStats(world);
  const queued = buildQueue(world);
  buildRecommendations(world, teams, queued);
  buildNotifications(world, teams);
  return world;
}

/** JSON columns get sql.json even for arrays of strings (strengths): a text[] would not cast to jsonb. */
function markJson(sql, rows) {
  for (const list of Object.values(rows)) {
    for (const row of list) {
      for (const key of Object.keys(row))
        if (JSON_COLUMNS.has(key) && row[key] !== null) row[key] = sql.json(row[key]);
    }
  }
}

async function main() {
  const env = loadEnv(repoRoot);
  const url = databaseUrl(env);
  const refusal = productionRefusal(env, url);
  if (refusal) throw new Error(`Refusing to seed demo data: ${refusal}`);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [{ foreign }] =
      await sql`select count(*)::int as foreign from auth."user" where id::text not like ${`${ID_PREFIX}-%`}`;
    if (foreign > MAX_FOREIGN_USERS) {
      throw new Error(
        `Refusing to seed demo data: ${foreign} real accounts in the database, this does not look like a local run`,
      );
    }
    const playbooks = await loadPlaybooks(sql);
    const world = build(playbooks);
    markJson(sql, world.rows);
    const deleted = await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const count = await wipe(tx);
      await insertAll(tx, world.rows);
      return count;
    });
    const total = Object.values(world.rows).reduce((sum, list) => sum + list.length, 0);
    process.stdout.write(
      `Demo data: removed ${deleted} old rows, wrote ${total} rows in ${Object.keys(world.rows).length} tables.\n`,
    );
    process.stdout.write(
      `Sign in at /sign-in with ${DEMO_ACCOUNTS.user}, ${DEMO_ACCOUNTS.newcomer} or ${DEMO_ACCOUNTS.admin} (admin); the link arrives in Mailpit.\n`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
