import { createHash } from 'node:crypto';

/**
 * Fixture builders (docs/plan.md, "Фикстуры"). Slice 1 has no domain tables, so these are
 * deterministic in-memory builders; each slice adds builders that insert rows directly into the
 * test database (no HTTP) and registers them here. Data is derived from a seed, never from the clock.
 */

/** Deterministic UUID-shaped id from a label: the same label always gives the same id. */
export function uuidFor(label: string): string {
  const hex = createHash('sha256').update(label).digest('hex');
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface UserFixture {
  id: string;
  email: string;
  displayName: string;
}

/** A user identity for `api(app).as(user)`; pass a distinct `label` per person in a scenario. */
export function user(label = 'user-1', overrides: Partial<UserFixture> = {}): UserFixture {
  return {
    id: uuidFor(`user:${label}`),
    email: `${label}@example.test`,
    displayName: label,
    ...overrides,
  };
}

/** Two people from different teams: the base of every IDOR scenario. */
export function twoTeams(): { a: UserFixture; b: UserFixture; teamA: string; teamB: string } {
  return {
    a: user('member-a'),
    b: user('member-b'),
    teamA: uuidFor('team:a'),
    teamB: uuidFor('team:b'),
  };
}

// Slice 2 (auth and profiles): callers, profile and resume builders, the operation table.
// The test world with the database, the application and the doubles is `./world.js` (imported
// directly: it depends on this file for `user()`).
export * from './clients.js';
export * from './operations.js';
export * from './profiles.js';
