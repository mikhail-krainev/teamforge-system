import { expect } from 'vitest';
import { PROFILE_STACK } from '../../../../test/fixtures/profiles.js';
import { TEAM_ROLES } from '../../../../test/fixtures/teams.js';
import { World, type WorldOptions } from '../../../../test/fixtures/world.js';
import type { InjectResponse } from '../../../../test/helpers/http.js';

/** Local helpers of the slice 4 (matching) API tests. */

export async function startWorld(options: WorldOptions = {}): Promise<World> {
  const world = await World.start(options);
  await world.ensureCatalog(TEAM_ROLES, PROFILE_STACK);
  return world;
}

/** `expectProblem` without a contract check, for statuses the contract leaves the code open for. */
export function expectCode(response: InjectResponse, status: number, code?: string): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(String(response.headers['content-type'])).toContain('application/problem+json');
  if (code) expect(response.json<{ code: string }>().code).toBe(code);
}

/** Response body without per-request noise, to compare two answers for equality. */
export function stripNoise(response: InjectResponse): Record<string, unknown> {
  const body = response.json<Record<string, unknown>>();
  delete body['requestId'];
  delete body['instance'];
  return body;
}
