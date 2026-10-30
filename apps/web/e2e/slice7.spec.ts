import { test } from '@playwright/test';
import { stopGithubDouble } from './support/github';
import { resetLoginRateLimit } from './support/stack';
import * as fixture from './support/slice6-steps';
import * as steps from './support/slice7-steps';
import {
  DISPLAY_NAMES,
  openSession,
  person,
  setPeople,
  signInWithGithub,
  type Person,
  type PersonKey,
} from './support/slice6-world';

/*
 * Slice 7 scenario (docs/plan.md, "Тесты среза" -> Playwright slice7.spec.ts, steps 1-7), written before the
 * implementation (S7-01): it must fail until slice 7 is done. This file only holds the skeleton (titles
 * carry the FR, CC and AF ids for scripts/trace-fr.mjs); the step bodies are in support/slice7-steps.ts
 * (credit, badges, axe), support/slice7-review-steps.ts (reviews), support/slice7-fraud-steps.ts (the
 * frozen project, the complaint, the administrator) and support/slice7-project-steps.ts (the second
 * project); the locators are in support/slice7-ui.ts, the shared state in support/slice7-world.ts.
 *
 * Five browser contexts sign in through the GitHub double (as in slice 6): the administrator, A (leads),
 * B (Backend), C (Frontend) and D (an outsider). Step 1 (the finished project of three participants) is
 * the fixture of slices 3-6: the steps of slice 6 are run as they are (the playbook, the team, the
 * repository, the webhooks, the role of a contribution, the release checks, "Завершить").
 * Requirements of the e2e stack: see the headers of slice2.spec.ts, slice5.spec.ts and slice6.spec.ts.
 * Extra ones of this scenario (listed in the report of S7-01):
 *   - time: the cooling (7 days) and the window of the reviews (14 days) are skipped by moving
 *     `rewards.credit_run` and `profiles.review_eligibility` in the throwaway database and running the
 *     worker jobs `rewards-cooling-end` and `review-publish` once through `dist/cli/run-job.js`, so both
 *     names must be on the closed list of apps/api/src/platform/queues/cli-jobs.ts (S7-02, S7-07);
 *   - release addresses of their own (pages the link-checker container can reach), because AF-02 wants an
 *     address unique among the completed projects and slice 6 holds the default one: E2E_FIRST_RELEASE_URL
 *     (default https://www.python.org/) for the first project, E2E_SECOND_RELEASE_URL (default
 *     https://www.mozilla.org/) for the second;
 *   - the GitHub accounts of the double are old enough for FR-GH-09 (the double says 2020).
 */

const PEOPLE: PersonKey[] = ['admin', 'a', 'b', 'c', 'd'];

function fixtureTests(): void {
  test('FR-PLAY-03, FR-TEAM-10, FR-WORK-01: the playbook is published and a team of three starts the project (fixture of slices 3-5)', async () => {
    steps.chooseTheReleaseAddress();
    await test.step(
      'FR-PLAY-03, FR-TEAM-10: the administrator publishes the scenario, the team starts',
      fixture.setupPlaybookAndStartedTeam,
    );
  });

  test('FR-GH-01, FR-GH-05: A binds the repository and the double delivers the work of B and C (fixture of slice 6)', async () => {
    await test.step(
      'FR-GH-01, FR-GH-11: install and bind',
      fixture.leadInstallsTheAppAndBindsTheRepository,
    );
    await test.step(
      'FR-GH-03, FR-GH-05: ten contributions arrive',
      fixture.doubleSendsIssueAndPullRequestWebhooks,
    );
    await test.step(
      'FR-WORK-17: B takes a second role and relabels a contribution',
      fixture.memberChangesTheRoleOfAContribution,
    );
  });

  test('FR-WORK-14, FR-GH-08, FR-WORK-13, FR-WORK-15, CC-13: the release is checked, the project is completed (step 1 of slice 7)', async () => {
    test.setTimeout(2 * fixture.CHECKS_TEST_TIMEOUT_MS);
    await test.step(
      'FR-WORK-14: the release checks',
      fixture.leadPastesTheReleaseLinkAndRunsTheChecks,
    );
    await test.step(
      'AF-11, AF-16, AF-17: the team is days old, its members are independent people',
      steps.theTeamIsIndependent,
    );
    await test.step('FR-WORK-13: "Завершить"', fixture.leadCompletesTheProject);
    await test.step(
      'FR-REW-11: the project of three participants is finished',
      steps.firstProjectIsFinished,
    );
  });
}

function creditTests(): void {
  test('FR-REW-11, AF-24: the participant sees "ожидание" with a countdown on /teams/[id]/credit and nothing is applied yet', async () => {
    await test.step(
      'FR-REW-11, AF-24: the status, the countdown, no awards yet, 404 for an outsider (axe)',
      steps.participantSeesTheCooling,
    );
  });

  test('FR-REW-01, FR-REW-02, FR-REW-04, FR-REW-06, CC-6: after 7 days the credit is "зачтено" once, by roles', async () => {
    await test.step(
      'FR-REW-06, CC-6: the cooling ends, "зачтено", a second run changes nothing (axe)',
      steps.coolingEndsAndTheProjectIsCredited,
    );
  });

  test('FR-REW-04, FR-REW-05, FR-REW-07, FR-PROF-06: the badge "Первый релиз" and the counter are on the profile, own and of others', async () => {
    await test.step(
      'FR-PROF-06, FR-REW-05: /profile and /users/[id], the catalog, no internals in the public api (axe)',
      steps.badgeAndCounterAppearOnTheProfile,
    );
  });
}

function reviewTests(): void {
  test('FR-PROF-08: two colleagues leave reviews; until the window closes the recipients see nothing', async () => {
    await test.step(
      'FR-PROF-08: the form, "отзывы будут опубликованы пакетом" (aria-live), the recipients see nothing (axe)',
      steps.reviewsAreWrittenAndStayHiddenInTheWindow,
    );
  });

  test('FR-PROF-08: a review of oneself, a second one of a pair and a review by an outsider are refused', async () => {
    await test.step(
      'FR-PROF-08: 422, 409 REVIEW_EXISTS, 404 for an outsider',
      steps.refusedReviewsAreExplainedByTheApi,
    );
  });

  test('FR-PROF-08, FR-REW-13: after the window the recipient with two authors sees both reviews without names, with the date', async () => {
    await test.step(
      'FR-PROF-08: the batch (no author, one date, UUID v4), one author means nothing, 409 REVIEW_WINDOW_CLOSED (axe)',
      steps.batchIsPublishedAfterTheWindowWithoutAuthors,
    );
  });

  test('FR-PROF-08: the list of sent reviews shows only the own ones', async () => {
    await test.step(
      'FR-PROF-08: the sent list of A, B and C',
      steps.sentListShowsOnlyTheOwnReviews,
    );
  });
}

function fraudTests(): void {
  test('FR-TEAM-10, FR-GH-01, AF-05: the same three start a second project with tiny pull requests', async () => {
    await test.step('FR-TEAM-10: the second team starts', steps.secondProjectStarts);
    await test.step(
      'FR-GH-01: the second repository is bound',
      fixture.leadInstallsTheAppAndBindsTheRepository,
    );
    await test.step(
      'AF-05: ten contributions, four pull requests of five lines each',
      steps.tinyPullRequestsAreDelivered,
    );
  });

  test('FR-WORK-13, FR-GH-08: the second project is completed through the wizard', async () => {
    test.setTimeout(2 * steps.CHECKS_TEST_TIMEOUT_MS);
    await test.step(
      'FR-WORK-13: the stages, the release, "Завершить"',
      steps.secondProjectIsCompleted,
    );
  });

  test('FR-REW-15, AF-05: the project with a suspicious signal goes "frozen" and the participants are not told the rule', async () => {
    await test.step(
      'FR-REW-15, AF-05: the status, no signals for the users, nothing credited (axe)',
      steps.secondProjectIsFrozen,
    );
  });

  test('FR-REW-11: a participant files a complaint in the cooling window, once; an outsider and a late one are refused', async () => {
    await test.step(
      'FR-REW-11: "Оспорить проект", the text, 409, 403/404, INVALID_STATE after the cooling (axe)',
      steps.participantFilesAComplaint,
    );
  });

  test('FR-REW-12, FR-REW-16, AF-25, CC-12: the administrator opens the case in /admin/fraud and decides "нарушение" with a confirmation', async () => {
    await test.step(
      'FR-REW-16, FR-AUTH-08: the queue, the card with the rules and the complaint, the decision with a confirmation (axe)',
      steps.administratorDecidesViolation,
    );
  });
}

function accessibilityTests(): void {
  test('FR-REW-05, FR-PROF-06, FR-PROF-08, FR-REW-16: every page of the slice is accessible (axe, WCAG AA)', async () => {
    await test.step(
      'FR-REW-16: /credit, /users/[id], /profile, /reviews, /admin/fraud',
      steps.everyPageOfTheSliceIsAccessible,
    );
  });
}

test.describe('slice 7: the credit, the awards, the reviews and the fraud review', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    resetLoginRateLimit(); // the earlier slices have used the sign-in allowance of this address
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

  fixtureTests();
  creditTests();
  reviewTests();
  fraudTests();
  accessibilityTests();
});
