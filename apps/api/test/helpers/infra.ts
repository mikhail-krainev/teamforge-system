import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe } from 'vitest';
import { databaseUrlFor, TEMPLATE_DB } from './db-url.js';

export type Need = 'db' | 'redis';

const available: Record<Need, boolean> = {
  db: Boolean(process.env.DATABASE_URL && process.env.DATABASE_DIRECT_URL),
  redis: Boolean(process.env.REDIS_URL),
};

const variables: Record<Need, string> = {
  db: 'DATABASE_URL + DATABASE_DIRECT_URL',
  redis: 'REDIS_URL',
};

/**
 * Integration suite that needs PostgreSQL and/or Redis. It is skipped EXPLICITLY (never silently)
 * when the environment variables are not set: the suite title says what is missing, and the
 * globalSetup prints a notice. CI provides the services, so nothing is skipped there.
 */
export function describeInfra(title: string, needs: Need[], body: () => void): void {
  const missing = needs.filter((need) => !available[need]);
  const label =
    missing.length > 0
      ? `${title} [SKIPPED: set ${missing.map((n) => variables[n]).join(' and ')}]`
      : title;
  describe.skipIf(missing.length > 0)(label, body);
}

export interface TestDatabase {
  /** App connection (through PgBouncer in CI). */
  url: string;
  /** Direct connection for fixtures and assertions. */
  directUrl: string;
  name: string;
  sql: postgres.Sql;
  drop(): Promise<void>;
}

const quiet = { prepare: false, onnotice: () => undefined } as const;

/** Clones the migrated template into a private database for one test file. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const directBase = process.env.DATABASE_DIRECT_URL ?? '';
  const appBase = process.env.DATABASE_URL ?? '';
  const name = `tf_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = postgres(directBase, { max: 1, ...quiet });
  try {
    await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const directUrl = databaseUrlFor(directBase, name);
  const sql = postgres(directUrl, { max: 5, ...quiet });
  return {
    url: databaseUrlFor(appBase, name),
    directUrl,
    name,
    sql,
    async drop() {
      await sql.end({ timeout: 5 });
      const dropper = postgres(directBase, { max: 1, ...quiet });
      try {
        await dropper.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await dropper.end({ timeout: 5 });
      }
    },
  };
}

/** Unique BullMQ prefix per test file keeps parallel files independent in one Redis. */
export function uniqueQueuePrefix(): string {
  return `tf-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

/** Polls until `check` returns a truthy value; no fixed sleeps (plan: waitFor with a limit). */
export async function waitFor<T>(
  check: () => Promise<T | false | undefined> | T | false | undefined,
  timeoutMs = 10_000,
  intervalMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** All callers are released at the same moment (architecture 12.5). */
export function barrier(count: number): { wait(): Promise<void> } {
  let arrived = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async wait() {
      arrived += 1;
      if (arrived >= count) release();
      await gate;
    },
  };
}
