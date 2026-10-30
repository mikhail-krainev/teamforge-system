import { startFakeLinkChecker, type FakeLinkChecker } from '../../../../test/fakes/link-checker.js';
import { waitEligibility } from '../../../../test/fixtures/reviews.js';
import { completedProject, membersOf, type Project } from '../../../../test/fixtures/rewards.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import { startRouteWorld } from '../../../../test/fixtures/workspace.js';
import type { World, WorldOptions } from '../../../../test/fixtures/world.js';
import { FakeClock } from '../../../../test/helpers/clock.js';

/** Local helpers of the peer review tests (S7-07): a world with a completed project and its review window. */

export interface ReviewWorld {
  world: World;
  clock: FakeClock;
  checker: FakeLinkChecker;
  /** An administrator: SEC-04 says that he does not see foreign reviews either. */
  admin: UserFixture;
  close(): Promise<void>;
}

/**
 * The GitHub double, one fake clock for the API and the worker (the window of C-27 is passed with
 * `clock.advance`), the fake link checker (the completion checks the release) and an administrator.
 */
export async function startReviewWorld(options: WorldOptions = {}): Promise<ReviewWorld> {
  const clock = options.clock instanceof FakeClock ? options.clock : new FakeClock(Date.now());
  const world = await startRouteWorld({ github: true, clock, ...options });
  const checker = startFakeLinkChecker(world.queuePrefix);
  const admin = await world.createUser('reviews-admin', { admin: true });
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

/** A completed project of the standard shape whose review window is open (`review_eligibility` of every member). */
export async function reviewProject(rw: ReviewWorld): Promise<Project> {
  const project = await completedProject(rw.world);
  await waitEligibility(rw.world, project.fx.team.id, membersOf(project));
  return project;
}

/** The text of a review that can be found in logs and responses by its marker. */
export const markedText = (marker: string): string =>
  `Спасибо за совместную работу над проектом, отзыв ${marker}: отвечал в тот же день.`;
