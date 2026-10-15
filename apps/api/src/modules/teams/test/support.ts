import { expect } from 'vitest';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import { TEAM_ROLES, type TeamDto } from '../../../../test/fixtures/teams.js';
import { World, type WorldOptions } from '../../../../test/fixtures/world.js';
import type { InjectResponse } from '../../../../test/helpers/http.js';

/** Local helpers of the teams API tests. */

export async function startWorld(options: WorldOptions = {}): Promise<World> {
  const world = await World.start(options);
  await world.ensureCatalog(TEAM_ROLES);
  return world;
}

export const DAY_MS = 24 * 3_600_000;

/** `expectProblem` without a contract check, for statuses the contract leaves the code open for. */
export function expectCode(response: InjectResponse, status: number, code?: string): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(String(response.headers['content-type'])).toContain('application/problem+json');
  if (code) expect(response.json<{ code: string }>().code).toBe(code);
}

export const getTeamAs = async (
  world: World,
  viewer: UserFixture,
  teamId: string,
): Promise<TeamDto> => {
  const response = await world.as(viewer).get(`/v1/teams/${teamId}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<TeamDto>();
};

/** Seconds between two ISO timestamps, rounded (C-12: an offer or invitation lives 7 days). */
export const secondsBetween = (from: string, to: string): number =>
  Math.round((Date.parse(to) - Date.parse(from)) / 1000);
