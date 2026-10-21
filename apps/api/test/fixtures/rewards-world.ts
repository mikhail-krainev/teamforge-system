import { startFakeLinkChecker, type FakeLinkChecker } from '../fakes/link-checker.js';
import { FakeClock } from '../helpers/clock.js';
import type { UserFixture } from './index.js';
import { startRouteWorld } from './workspace.js';
import type { World, WorldOptions } from './world.js';

/**
 * The world of the slice 7 concurrency tests (the module tests keep their own copy in
 * modules/rewards/test/support.ts, because a test of one module may not import a test of another): the GitHub
 * double, a fake clock shared by the API and the worker (the cooling of 7 days and the review window of 14 days
 * pass with `clock.advance`), the fake link checker (the completion checks the release) and an administrator.
 */
export interface RewardsWorld {
  world: World;
  clock: FakeClock;
  checker: FakeLinkChecker;
  admin: UserFixture;
  close(): Promise<void>;
}

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
