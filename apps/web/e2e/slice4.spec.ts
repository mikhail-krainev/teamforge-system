import { test } from '@playwright/test';
import { stopGithubDouble } from './support/github';
import { resetLoginRateLimit } from './support/stack';
import * as steps from './support/slice4-steps';
import {
  DISPLAY_NAMES,
  openSession,
  person,
  setPeople,
  signInWithGithub,
  type PersonKey,
} from './support/slice4-world';
import type { Person } from './support/slice3-world';

/*
 * Slice 4 scenario (docs/plan.md, "Тесты среза" -> Playwright slice4.spec.ts, steps 1-8), written
 * before the implementation (S4-01): it must fail until slice 4 is done. This file only holds the
 * skeleton (titles carry the FR ids for scripts/trace-fr.mjs); the step bodies are in
 * support/slice4-steps.ts, the locators in support/slice4-ui.ts, the shared state in slice4-world.ts.
 *
 * Three browser contexts: A (creates the team, leads it), B (stands in the queue, is auto-added,
 * excluded, applies) and C (leads a second team). All sign in through the GitHub double (requirements of the e2e stack: see the
 * header of slice2.spec.ts and slice3.spec.ts).
 *
 * Extra requirements of this scenario:
 *   - the worker runs `matching-auto-add` every minute (architecture 6.4) and `matching-recompute`
 *     5 s after the events (6.3); there is no test-only endpoint in the e2e stack (api and worker run
 *     as `development`), so step 4 runs one `matching-auto-add` pass through the worker CLI
 *     (`docker compose exec worker node dist/cli/run-job.js matching-auto-add`, support/stack.ts);
 *   - a third browser context C leads a second team, created in the world setup of step 7.
 */

const PEOPLE: PersonKey[] = ['a', 'b', 'c'];

function queueTests(): void {
  test('FR-TEAM-01, FR-TEAM-02: A creates a team with an open Backend seat', async () => {
    await test.step(
      'FR-TEAM-01, FR-TEAM-02: the team with one open Backend seat',
      steps.aCreatesTeamWithOpenBackendSeat,
    );
  });
  test('FR-MATCH-03, FR-AUTH-05: B, with a linked GitHub, stands in the queue for Backend', async () => {
    await test.step(
      'FR-MATCH-03: the form, the status "Ты в очереди", the role list (axe)',
      steps.bStandsInTheQueue,
    );
  });
  test('FR-MATCH-09, FR-PROF-07: the demand showcase shows the queue and the open seat', async () => {
    await test.step(
      'FR-MATCH-09: the Backend row moved: one more person in the queue, an open seat (axe)',
      steps.demandShowsTheQueue,
    );
  });
}

function autoAddTests(): void {
  test('FR-MATCH-05, FR-MATCH-06, FR-MATCH-07: the auto-add fires and B joins as an auto-added member', async () => {
    await test.step(
      'FR-MATCH-05: B becomes eligible, one matching-auto-add run (worker CLI) takes him in',
      steps.autoAddFires,
    );
  });
  test('FR-TEAM-22, FR-WORK-19: B sees the trial badge in the roster, A got the notification', async () => {
    await test.step(
      'FR-MATCH-05, FR-TEAM-22: the trial badge on the roster (axe); the notification of the lead',
      steps.bSeesTheTrialBadgeAndALearnsOfIt,
    );
  });
}

function trialAndRecommendationTests(): void {
  test('FR-TEAM-22, FR-MATCH-08: A excludes B in the trial, B is back in the queue with the same wait', async () => {
    await test.step(
      'FR-TEAM-22, FR-MATCH-08: exclusion with a confirmation; the same application, the same enqueuedAt',
      steps.aExcludesBAndBIsBackInTheQueue,
    );
  });
  test('FR-MATCH-02, FR-TEAM-29: B opens the recommended teams and applies for the seat', async () => {
    await test.step(
      'FR-MATCH-02, FR-MATCH-08: the other team is recommended, the excluding one is not; "Подать заявку", the request is pending (axe)',
      steps.bAppliesFromTheRecommendations,
    );
  });
  test('FR-MATCH-01, FR-PROF-07: every page of the slice is accessible (axe, WCAG AA)', async () => {
    await test.step(
      'FR-MATCH-01: search, demand, profile block, seat candidates, team page',
      steps.everyPageOfTheSliceIsAccessible,
    );
  });
}

test.describe('slice 4: matching and the search queue', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    resetLoginRateLimit(); // slices 1-3 have used the sign-in allowance of this address
    // One after another: the GitHub double hands out one prepared identity per sign-in.
    const signedIn: [PersonKey, Person][] = [];
    for (const key of PEOPLE) {
      signedIn.push([key, await signInWithGithub(await openSession(browser), DISPLAY_NAMES[key])]);
    }
    setPeople(Object.fromEntries(signedIn) as Record<PersonKey, Person>);
  });

  test.afterAll(async () => {
    for (const key of PEOPLE)
      await person(key)
        .session.context.close()
        .catch(() => undefined);
    setPeople(undefined);
    await stopGithubDouble();
  });

  queueTests();
  autoAddTests();
  trialAndRecommendationTests();
});
