import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { expect } from 'vitest';
import type { ProblemBody } from '../../../../test/fixtures/assertions.js';
import { expectMatchesContract } from '../../../../test/helpers/contract.js';
import type { InjectResponse } from '../../../../test/helpers/http.js';

/** Local helpers of the profiles API tests (kept here: `apps/api/test/**` is shared and not edited by this suite). */

export interface ProfileDto {
  userId: string;
  displayName: string;
  timezone: string;
  hoursPerWeek: number;
  portfolioUrl: string | null;
  stack: string[];
  rolePrefs: { roleCode: string; level: string }[];
  experience: { title: string; description?: string; from: string; to?: string | null }[];
  strengths: string[];
  weaknesses: string[];
  version: number;
  updatedAt: string;
}

export interface CatalogEntryDto {
  code: string;
  name: string;
  active: boolean;
}

export interface ResumeDto {
  id: string;
  status: 'queued' | 'processing' | 'done' | 'failed';
  failureReason?: string | null;
  extractedText?: string | null;
  suggestions?: Record<string, unknown> | null;
  keepFile: boolean;
  createdAt: string;
  processedAt?: string | null;
}

/** `ResumeUpload.failureReason` values the contract allows besides null. */
export const FAILURE_REASONS = ['scan_without_text', 'timeout', 'limit_exceeded', 'corrupted'];

/** Short random hex, for unique labels and catalog codes (the test database is shared inside a file). */
export const hex = (length = 8): string => randomUUID().replaceAll('-', '').slice(0, length);

/** A catalog code valid for roles (`^[a-z][a-z0-9_]{1,31}$`) and stack tags, unique per call. */
export const codeOf = (prefix: string): string => `${prefix}_${hex()}`;

/** A label for `World.createUser`, unique per call. */
export const labelOf = (prefix: string): string => `${prefix}-${hex(6)}`;

/**
 * A problem+json answer whose status the contract declares for the operation. Unlike `expectProblem`
 * it does not pin the machine code (for places where the contract leaves the domain code open).
 */
export function expectStatus(
  operationId: string,
  response: InjectResponse,
  status: number,
): ProblemBody {
  expect(response.statusCode, `${operationId}: ${response.body}`).toBe(status);
  expect(String(response.headers['content-type'])).toContain('application/problem+json');
  expectMatchesContract(operationId, response);
  return response.json<ProblemBody>();
}

/** The `errors[].pointer` values of a problem body. */
export const pointersOf = (body: ProblemBody): string[] =>
  (body.errors ?? []).map((e) => e.pointer);

/** Asserts that some `errors[].pointer` starts with `prefix` (JSON pointer of the offending field). */
export function expectPointer(body: ProblemBody, prefix: string): void {
  const pointers = pointersOf(body);
  expect(
    pointers.some((p) => p.startsWith(prefix)),
    `no error pointer starting with "${prefix}" in ${JSON.stringify(pointers)}`,
  ).toBe(true);
}

export interface ChildRows {
  profile: { display_name: string; version: number; strengths: unknown; weaknesses: unknown }[];
  stack: string[];
  roles: { role_code: string; level: string; ordinal: number }[];
  experience: { title: string; ordinal: number }[];
}

/** The profile row and all child rows of a user, straight from the database. */
export async function childRows(sql: postgres.Sql, userId: string): Promise<ChildRows> {
  const profile = await sql<ChildRows['profile']>`
    SELECT display_name, version, strengths, weaknesses FROM profiles.profile WHERE user_id = ${userId}`;
  const stack = await sql<{ stack_tag_code: string }[]>`
    SELECT stack_tag_code FROM profiles.profile_stack WHERE user_id = ${userId} ORDER BY stack_tag_code`;
  const roles = await sql<ChildRows['roles']>`
    SELECT role_code, level, ordinal::int AS ordinal FROM profiles.profile_role_pref
     WHERE user_id = ${userId} ORDER BY ordinal`;
  const experience = await sql<ChildRows['experience']>`
    SELECT title, ordinal::int AS ordinal FROM profiles.profile_experience
     WHERE user_id = ${userId} ORDER BY ordinal`;
  return {
    profile: [...profile],
    stack: stack.map((r) => r.stack_tag_code),
    roles: [...roles],
    experience: [...experience],
  };
}

/** Number of `profiles.profile_updated` outbox rows about a user. */
export async function profileEvents(
  sql: postgres.Sql,
  userId: string,
): Promise<{ module: string; type: string }[]> {
  const rows = await sql<{ module: string; type: string }[]>`
    SELECT module, type FROM platform.outbox_event
     WHERE aggregate_id = ${userId} AND module = 'profiles' AND type LIKE '%profile_updated'`;
  return [...rows];
}

/** Inserts a role / stack tag straight into the catalog (fixture, no HTTP). */
export async function insertCatalogEntry(
  sql: postgres.Sql,
  kind: 'role' | 'stack tag',
  code: string,
  options: { active?: boolean; name?: string } = {},
): Promise<void> {
  const active = options.active ?? true;
  const name = options.name ?? code;
  if (kind === 'role') {
    await sql`
      INSERT INTO profiles.role (code, name, active, ordinal)
      VALUES (${code}, ${name}, ${active}, 950 + (SELECT count(*)::int FROM profiles.role))`;
  } else {
    await sql`INSERT INTO profiles.stack_tag (code, name, active) VALUES (${code}, ${name}, ${active})`;
  }
}

export async function setCatalogActive(
  sql: postgres.Sql,
  kind: 'role' | 'stack tag',
  code: string,
  active: boolean,
): Promise<void> {
  if (kind === 'role') await sql`UPDATE profiles.role SET active = ${active} WHERE code = ${code}`;
  else await sql`UPDATE profiles.stack_tag SET active = ${active} WHERE code = ${code}`;
}
