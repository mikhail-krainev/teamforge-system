import { test } from '@playwright/test';
import { stopGithubDouble } from './support/github';
import { resetLoginRateLimit } from './support/stack';
import * as steps from './support/slice5-steps';
import {
  DISPLAY_NAMES,
  openSession,
  person,
  setPeople,
  signInWithGithub,
  type Person,
  type PersonKey,
} from './support/slice5-world';

/*
 * Slice 5 scenario (docs/plan.md, "Тесты среза" -> Playwright slice5.spec.ts, steps 1-9), written before the
 * implementation (S5-01): it must fail until slice 5 is done. This file only holds the skeleton (titles
 * carry the FR ids for scripts/trace-fr.mjs); the step bodies are in support/slice5-steps.ts, the locators
 * in support/slice5-ui.ts, the shared state in support/slice5-world.ts.
 *
 * Four browser contexts sign in through the GitHub double: the administrator, A (leads the team),
 * B (Backend) and C (Frontend). Requirements of the e2e stack: see the headers of slice2.spec.ts and
 * slice3.spec.ts. Extra requirements of this scenario:
 *   - the link-checker service of S5-09 runs in the e2e stack (a link ends `ok` or `broken`);
 *   - the 24 hours of C-08 are skipped by moving the opening of the stage back in the e2e database;
 *   - the administrator flag is set in the same database (administrators are issued outside the UI).
 */

function publishAndStartTests(): void {
  test('FR-PLAY-01, FR-PLAY-03, FR-PLAY-05: the administrator uploads and publishes the scenario through the API', async () => {
    await test.step(
      'FR-PLAY-05, FR-PLAY-03: uploadPlaybook (draft), publishPlaybook, the scenario is listed',
      steps.adminPublishesThePlaybook,
    );
  });

  test('FR-TEAM-10, FR-WORK-01, FR-PLAY-03: a team of three on the new scenario starts the project', async () => {
    await test.step(
      'FR-TEAM-10, FR-WORK-01: the team is pinned to the scenario; "Начать проект" opens stage 1',
      steps.teamOfThreeStartsTheProject,
    );
  });

  test('FR-WORK-01, FR-WORK-02, FR-WORK-12: /route shows stage 1 and the page of the stage lists its items', async () => {
    await test.step(
      'FR-WORK-01: the timeline, the current stage, the due date, the items with executors and the fallback step (axe)',
      steps.routeShowsStageOneAndItsItems,
    );
  });
}

function workTests(): void {
  test('FR-WORK-04, FR-WORK-05, FR-PLAY-08: B uploads a file, C pastes a link that gets checked, both close their items', async () => {
    await test.step(
      'FR-WORK-05, FR-WORK-04: upload with the result, download link, the link check (unchecked -> ok or broken), done (axe)',
      steps.bUploadsAFileCPastesALinkAndCloseItems,
    );
  });

  test('FR-WORK-07: two people edit one item at once, the second sees the version conflict and the actual value', async () => {
    await test.step(
      'FR-WORK-07: 409 VERSION_CONFLICT is shown with the current value; "применить мои изменения заново" saves (axe)',
      steps.twoPeopleEditOneItemAndTheSecondSeesTheConflict,
    );
  });

  test('FR-WORK-09: the review checklist is filled with one "no", the lead accepts it as a risk', async () => {
    await test.step(
      'FR-WORK-09: C answers да/нет/да, "ревью не пройдено"; A accepts the risk with a reason, "ревью пройдено" (axe)',
      steps.reviewWithOneNoAndTheLeadAcceptsTheRisk,
    );
  });

  test('FR-WORK-10, FR-WORK-03: "Перейти" before the conditions lists what is unmet; after them stage 2 opens; a stale tab learns STAGE_NOT_OPEN', async () => {
    await test.step(
      'FR-WORK-10: unmet[] as a list (axe); all conditions met -> stage 2 is open; the second tab gets 409 STAGE_NOT_OPEN',
      steps.transitionIsBlockedThenSucceeds,
    );
  });

  test('FR-WORK-04, SEC-05: a link to http://127.0.0.1 is refused with a clear message', async () => {
    await test.step(
      'FR-WORK-04: LINK_REJECTED is shown as text, nothing is saved (axe)',
      steps.internalLinkIsRefusedWithAClearMessage,
    );
  });

  test('FR-WORK-01: every page of the slice is accessible (axe, WCAG AA)', async () => {
    await test.step(
      'FR-WORK-01: route, stage 1 (closed), stage 2 (open)',
      steps.everyPageOfTheSliceIsAccessible,
    );
  });
}

const PEOPLE: PersonKey[] = ['admin', 'a', 'b', 'c'];

test.describe('slice 5: the route of a project', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    resetLoginRateLimit(); // slices 1-4 have used the sign-in allowance of this address
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

  publishAndStartTests();
  workTests();
});
