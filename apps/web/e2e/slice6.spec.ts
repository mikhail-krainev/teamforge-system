import { test } from '@playwright/test';
import { stopGithubDouble } from './support/github';
import { resetLoginRateLimit } from './support/stack';
import * as steps from './support/slice6-steps';
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
 * Slice 6 scenario (docs/plan.md, "Тесты среза" -> Playwright slice6.spec.ts, steps 1-8), written before the
 * implementation (S6-02): it must fail until slice 6 is done. This file only holds the skeleton (titles
 * carry the FR ids for scripts/trace-fr.mjs); the step bodies are in support/slice6-steps.ts, the locators
 * in support/slice6-ui.ts, the shared state in support/slice6-world.ts.
 *
 * Five browser contexts sign in through the GitHub double: the administrator (publishes the playbook of
 * slice 5), A (leads the team), B (Backend), C (Frontend) and D (leads a second team). GitHub itself (App,
 * repository, issues, pull requests, webhooks) is the double of apps/api/test/fakes/github-app.ts.
 * Requirements of the e2e stack: see the headers of slice2.spec.ts and slice5.spec.ts. Extra ones are listed
 * in the header of support/slice6-steps.ts (GitHub App settings in the compose environment; a release page
 * the link-checker container can reach).
 */

const PEOPLE: PersonKey[] = ['admin', 'a', 'b', 'c', 'd'];

function setupTests(): void {
  test('FR-PLAY-03, FR-TEAM-10, FR-WORK-01: the playbook is published and a team of three starts the project (setup of slice 5)', async () => {
    await test.step(
      'FR-PLAY-03, FR-TEAM-10: the administrator publishes the scenario, the team starts',
      steps.setupPlaybookAndStartedTeam,
    );
  });
}

function githubTests(): void {
  test('FR-GH-01, FR-GH-11: A installs the App, comes back, chooses the repository and binds it', async () => {
    await test.step(
      'FR-GH-01, FR-GH-11: "Установить GitHub App", the return page, the list of repositories, the binding (axe)',
      steps.leadInstallsTheAppAndBindsTheRepository,
    );
  });

  test('FR-GH-03, FR-GH-04, FR-GH-05: the double sends "issue opened/closed" and "PR merged"; a wrong signature is refused', async () => {
    await test.step(
      'FR-GH-03, FR-GH-04, FR-GH-05: signed deliveries are accepted, a forged one is 401, a repeated one is ignored',
      steps.doubleSendsIssueAndPullRequestWebhooks,
    );
  });
}

function feedTests(): void {
  test('FR-WORK-16, FR-GH-05: the feed shows the entries with the executor and the role', async () => {
    await test.step(
      'FR-WORK-16: the list, the executor filter, the summary by member and role (axe)',
      steps.feedShowsEntriesWithExecutorAndRole,
    );
  });

  test('FR-WORK-17: a member changes the role of his contribution with a confirmation', async () => {
    await test.step(
      'FR-WORK-17: "Сменить роль", the choice among his roles, the confirmation; the entry of somebody else has no such button (axe)',
      steps.memberChangesTheRoleOfAContribution,
    );
  });

  test('FR-GH-02, CC-9: a second team binds the same repository and sees REPO_TAKEN', async () => {
    await test.step(
      'FR-GH-02: the message "уже привязан к другой команде"; the second team still has no repository (axe)',
      steps.secondTeamMeetsRepoTaken,
    );
  });
}

function completionTests(): void {
  test('FR-WORK-14, FR-GH-08, FR-PLAY-08: on the release stage the lead pastes the link and runs the checks; the release is checked twice', async () => {
    test.setTimeout(steps.CHECKS_TEST_TIMEOUT_MS);
    await test.step(
      'FR-WORK-14, FR-GH-08: the link, the checks with their reasons, the timer to the second check; after a day all green (axe)',
      steps.leadPastesTheReleaseLinkAndRunsTheChecks,
    );
  });

  test('FR-WORK-13, FR-WORK-15, CC-13: "Завершить" gives the results screen with the snapshot; a second press is impossible', async () => {
    test.setTimeout(steps.CHECKS_TEST_TIMEOUT_MS);
    await test.step(
      'FR-WORK-13, FR-WORK-15: the results (no delay, the composition, the contribution by role), no second press (axe)',
      steps.leadCompletesTheProject,
    );
  });

  test('FR-WORK-13: every page of the slice is accessible (axe, WCAG AA)', async () => {
    await test.step('FR-WORK-13: /github, /feed, /complete', steps.everyPageOfTheSliceIsAccessible);
  });
}

test.describe('slice 6: GitHub, the feed and the completion of a project', () => {
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

  setupTests();
  githubTests();
  feedTests();
  completionTests();
});
