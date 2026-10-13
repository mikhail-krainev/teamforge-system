import { test } from '@playwright/test';
import { stopGithubDouble } from './support/github';
import * as steps from './support/slice3-steps';
import {
  openSession,
  person,
  setPeople,
  signInWithGithub,
  type Person,
  type PersonKey,
} from './support/slice3-world';

/*
 * Slice 3 scenario (docs/plan.md, "Тесты среза" -> Playwright slice3.spec.ts, steps 1-8), written
 * before the implementation (S3-01): it must fail until slice 3 is done. This file only holds the
 * skeleton (titles carry the FR ids for scripts/trace-fr.mjs); the step bodies are in
 * support/slice3-steps.ts, the locators in support/slice3-ui.ts, the shared state in slice3-world.ts.
 *
 * Five browser contexts: A (creates the team, leads it), B (joins by the invitation link, later the
 * new lead), C (accepts an offer), D and E (race for the last seat). Everyone signs in through the
 * GitHub double (a linked GitHub account is required to join, FR-AUTH-05) - see the requirements for
 * the e2e compose stack in the header of slice2.spec.ts (double on the host, api/worker env, Mailpit).
 *
 * Extra requirements of this scenario:
 *   - the worker runs the `vote-deadline-scan` every minute (architecture 8.3); step 7 moves the
 *     nomination deadline of the open vote into the past with psql in the postgres container of the
 *     `e2e` project (`docker compose -p e2e exec postgres psql -U postgres -d teamforge`) and waits for
 *     the scan, so that the 24 hours of C-16 do not have to pass;
 *   - routes and copy follow plan S3-11..S3-13; see support/slice3-ui.ts (open question: the route of
 *     the incoming offers is not in the plan, `/offers` is assumed).
 */

const PEOPLE: [PersonKey, string][] = [
  ['a', 'Анна Лидова'],
  ['b', 'Борис Второв'],
  ['c', 'Вера Третьева'],
  ['d', 'Глеб Четверов'],
  ['e', 'Дарья Пятова'],
];

function teamAndInvitationTests(): void {
  test('FR-TEAM-01, FR-TEAM-02, FR-PLAY-06: A creates a "Веб-сервис" team with three seats', async () => {
    await test.step('FR-TEAM-01: the creation form is accessible (axe)', steps.formIsAccessible);
    await test.step(
      'FR-TEAM-01, FR-TEAM-02: fill in the form, three seats, create',
      steps.createTeamWithThreeSeats,
    );
    await test.step(
      'FR-TEAM-01, FR-TEAM-27: A is the lead of a forming team with three open seats',
      steps.teamPageShowsCreator,
    );
  });

  test('FR-TEAM-08: A creates an invitation and copies the link', async () => {
    await test.step(
      'FR-TEAM-08: create the invitation, the link carries the token in the fragment',
      steps.createInvitationLink,
    );
    await test.step('FR-TEAM-08: copy the link (axe)', steps.copyTheLink);
  });

  test('FR-TEAM-09, FR-WORK-19: B opens the link, sees the preview, accepts; A sees it live', async () => {
    await test.step(
      'FR-TEAM-09: the preview names the team (axe)',
      steps.bOpensTheLinkAndSeesThePreview,
    );
    await test.step('FR-TEAM-09, FR-TEAM-04: B accepts and joins', steps.bAcceptsTheInvitation);
    await test.step(
      'FR-WORK-19: A gets the new member and the notification without a reload (axe)',
      steps.aSeesBLiveWithANotification,
    );
  });
}

function offerAndRaceTests(): void {
  test('FR-TEAM-28, FR-TEAM-30: A offers a seat to C, C accepts', async () => {
    await test.step('FR-TEAM-28: A sends the offer', steps.aOffersASeatToC);
    await test.step('FR-TEAM-30: C accepts and joins (axe)', steps.cAcceptsTheOffer);
  });

  test('FR-TEAM-04, FR-TEAM-30: D and E accept offers for the last seat at the same moment', async () => {
    await test.step(
      'FR-TEAM-28: two offers for the last open seat',
      steps.dAndEHoldOffersForTheLastSeat,
    );
    await test.step('FR-TEAM-04: one joins, the other is refused', steps.theyAcceptTogether);
    await test.step(
      'FR-TEAM-04: the loser reads a clear message (axe); four members',
      steps.theLoserGetsAClearMessage,
    );
  });

  test('FR-TEAM-10: A starts the project', async () => {
    await test.step('FR-TEAM-10, FR-TEAM-27: the status becomes "active"', steps.aStartsTheProject);
  });
}

function leaderVoteTest(): void {
  test('FR-TEAM-14, FR-TEAM-15, FR-TEAM-16, FR-TEAM-17: A leaves, B is elected the lead', async () => {
    await test.step('FR-TEAM-14: A leaves, the vote opens (axe)', steps.aLeavesAndTheVoteOpens);
    await test.step('FR-TEAM-15: B nominates himself and consents', steps.bNominatesHimself);
    await test.step(
      'FR-TEAM-15: the nomination period ends, the phase is announced',
      steps.theNominationPeriodEnds,
    );
    await test.step(
      'FR-TEAM-16, FR-TEAM-17: B and C vote for B, the vote closes early',
      steps.bAndCVoteForB,
    );
    await test.step(
      'FR-TEAM-17: B confirms and becomes the lead (axe)',
      steps.bConfirmsAndBecomesTheLead,
    );
  });

  test('FR-TEAM-26: every page of the slice is accessible (axe, WCAG AA)', async () => {
    await test.step(
      'FR-TEAM-26: catalog, form, team, vote, offers, invitation',
      steps.everyPageOfTheSliceIsAccessible,
    );
  });
}

test.describe('slice 3: teams and roles', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    // One after another: the GitHub double hands out one prepared identity per sign-in.
    const signedIn: [PersonKey, Person][] = [];
    for (const [key, name] of PEOPLE) {
      signedIn.push([key, await signInWithGithub(await openSession(browser), name)]);
    }
    setPeople(Object.fromEntries(signedIn) as Record<PersonKey, Person>);
  });

  test.afterAll(async () => {
    for (const [key] of PEOPLE)
      await person(key)
        .session.context.close()
        .catch(() => undefined);
    setPeople(undefined);
    await stopGithubDouble();
  });

  teamAndInvitationTests();
  offerAndRaceTests();
  leaderVoteTest();
});
