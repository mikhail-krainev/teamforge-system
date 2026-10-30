import { expect } from 'vitest';
import { startFakeLinkChecker, type FakeLinkChecker } from '../../../../test/fakes/link-checker.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import { startRouteWorld } from '../../../../test/fixtures/workspace.js';
import type { World, WorldOptions } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';
import type { InjectResponse } from '../../../../test/helpers/http.js';

/** Local helpers of the slice 7 API tests. */

export interface RewardsWorld {
  world: World;
  clock: FakeClock;
  checker: FakeLinkChecker;
  /** An administrator (`auth.user.is_admin`): the queue of manual review (FR-REW-16). */
  admin: UserFixture;
  close(): Promise<void>;
}

/**
 * The world every credited project needs: the GitHub double, a fake clock shared by the API and the worker
 * (the cooling of 7 days and the window of 14 days are passed with `clock.advance`), the fake link checker
 * (the completion checks the release), and an administrator.
 */
export async function startRewardsWorld(options: WorldOptions = {}): Promise<RewardsWorld> {
  const clock = options.clock instanceof FakeClock ? options.clock : new FakeClock(Date.now());
  const world = await startRouteWorld({ github: true, clock, ...options });
  const checker = startFakeLinkChecker(world.queuePrefix);
  const admin = await world.createUser('rewards-admin', { admin: true });
  return {
    world,
    clock,
    checker,
    admin,
    async close() {
      await checker.close();
      await world.close();
    },
  };
}

/** The body of a problem+json answer or of a normal one as text, for "does not contain" checks. */
export const bodyText = (response: InjectResponse): string => response.body;

/** Fields of the answer, recursively, so that a check for a forbidden field name sees nested ones too. */
export function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...keysDeep(inner)]);
  }
  return [];
}

/** Nothing of the anti-fraud machinery reaches an ordinary user (FR-REW-15, FR-REW-16): no rule codes, no scores. */
export function expectNoFraudDetails(response: InjectResponse): void {
  expect(response.body).not.toMatch(/AF-\d{2}/);
  const keys = keysDeep(response.json());
  for (const forbidden of ['signals', 'fraud', 'fraudScore', 'ruleCode', 'score', 'data']) {
    expect(keys, `field "${forbidden}" in ${response.body}`).not.toContain(forbidden);
  }
}

export const DAY_MS = 24 * 3_600_000;
