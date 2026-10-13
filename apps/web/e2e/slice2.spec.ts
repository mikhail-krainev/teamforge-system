import { test } from '@playwright/test';
import * as auth from './support/slice2-auth-steps';
import * as profile from './support/slice2-profile-steps';
import { stopGithubDouble } from './support/github';
import { openSession, sessions, setSessions } from './support/slice2-world';

/*
 * Slice 2 scenario (docs/plan.md, "Тесты среза" -> Playwright slice2.spec.ts), written before the
 * implementation (S2-02): it must fail until slice 2 is done. This file only holds the scenario
 * skeleton (titles carry the FR ids for scripts/trace-fr.mjs); the step bodies are in
 * support/slice2-auth-steps.ts and support/slice2-profile-steps.ts, the locators in support/slice2-ui.ts.
 *
 * Requirements for the e2e compose stack (the orchestrator provides them; this spec cannot):
 *   - mail: api and worker send through the Mailpit of the project (SMTP 11025, UI/API 18025), and the
 *     links in the mails are built on the web origin (APP_ORIGIN / WEB_URL = http://localhost:3100);
 *   - GitHub sign-in (step 7) runs against the double of apps/api/test/fakes/github-server.ts that this
 *     spec starts on 0.0.0.0:${E2E_GITHUB_PORT:-4900}. api must therefore run with
 *       GITHUB_OAUTH_BASE_URL=http://host.docker.internal:4900
 *       GITHUB_API_BASE_URL=http://host.docker.internal:4900
 *       GITHUB_APP_CLIENT_ID=Iv1.testclientid0001
 *       GITHUB_APP_CLIENT_SECRET=test-github-client-secret-0001
 *     (the double's defaults; `githubComposeEnv()` in support/github.ts returns this map, and
 *     E2E_GITHUB_CLIENT_ID / E2E_GITHUB_CLIENT_SECRET override the credentials), and the api container
 *     must resolve host.docker.internal (Docker Desktop does; on Linux add extra_hosts host-gateway);
 *   - the resume-worker container is up (the PDF is parsed in it) and MinIO is reachable;
 *   - rate limits are the production ones (C-31: 5 link requests per hour per address, 20 per IP). The
 *     scenario uses about ten link requests, so a stack reused within the hour may hit the IP limit.
 */

function signInTest(): void {
  test('FR-AUTH-02, FR-AUTH-01: sign in with a magic link from the mail', async () => {
    await test.step('FR-AUTH-02: /sign-in is accessible (axe)', auth.signInPageIsAccessible);
    await test.step(
      'FR-AUTH-02: request the link; the mail has the token in the URL fragment',
      auth.requestMagicLink,
    );
    await test.step(
      'FR-AUTH-02: /auth/confirm without a token reports it (axe)',
      auth.confirmWithoutTokenIsReported,
    );
    await test.step(
      'FR-AUTH-02, FR-AUTH-01: open the link, confirm: signed in with an HttpOnly cookie',
      auth.openLinkAndSignIn,
    );
    await test.step(
      'FR-AUTH-02: the one-time link cannot be used twice',
      auth.linkCannotBeUsedTwice,
    );
  });
}

function consentTest(): void {
  test('FR-AUTH-03: the consent screen blocks everything until it is accepted', async () => {
    await test.step(
      'FR-AUTH-03: /profile shows the consent screen, the API answers CONSENT_REQUIRED',
      auth.consentBlocksTheApp,
    );
    await test.step(
      'FR-AUTH-03: the consent screen is accessible (axe) and names the GitHub transfer',
      auth.consentScreenIsAccessible,
    );
    await test.step(
      'FR-AUTH-03: accept the consent: the profile page opens',
      auth.acceptConsentInUi,
    );
  });
}

function profileTest(): void {
  test('FR-PROF-01: fill in the profile, save it, and the data survives a reload', async () => {
    await test.step(
      'FR-PROF-01: fill in name, timezone, hours, portfolio, notes',
      profile.fillBasics,
    );
    await test.step(
      'FR-PROF-01: two roles from the catalog with priorities and levels',
      profile.pickTwoRolesWithPriorities,
    );
    await test.step('FR-PROF-01: three stack tags from the catalog', profile.pickThreeStackTags);
    await test.step('FR-PROF-01: one experience entry', profile.addOneExperience);
    await test.step('FR-PROF-01: save; the API returns what was entered', profile.saveProfile);
    await test.step(
      'FR-PROF-01: after a reload the data is still there (axe on /profile)',
      profile.reloadKeepsTheData,
    );
  });
}

function resumeTest(): void {
  test('FR-PROF-02, FR-PROF-03, FR-PROF-04, FR-PROF-05: resume upload, parse, confirm, delete', async () => {
    test.setTimeout(420_000);
    await test.step(
      'FR-PROF-02, FR-PROF-03: upload the PDF and wait for the aria-live status "ready"',
      profile.uploadPdfAndWaitForReady,
    );
    await test.step(
      'FR-PROF-04: the extracted text is shown as plain text, the profile is untouched',
      profile.extractedTextIsPlainAndProfileUntouched,
    );
    await test.step(
      'FR-PROF-03: /profile with the parse result is accessible (axe)',
      profile.profileWithResumeIsAccessible,
    );
    await test.step(
      'FR-PROF-04, FR-PROF-05: confirm a suggested field; keepFile off removes the file',
      profile.confirmSuggestedFieldWithoutKeepingTheFile,
    );
    await test.step(
      'FR-PROF-05: a second upload can be deleted by the user',
      profile.secondUploadCanBeDeleted,
    );
  });
}

function publicProfileTest(): void {
  test('FR-PROF-01, FR-AUTH-03: the public profile is closed to guests and shows public fields only', async () => {
    await test.step(
      'FR-AUTH-03: without a session /users/<id> leads to sign-in and shows no data',
      profile.guestIsSentToSignIn,
    );
    await test.step(
      'FR-AUTH-02: a second user signs in with a magic link (API helper) and accepts consent',
      profile.secondUserSignsIn,
    );
    await test.step(
      'FR-PROF-01: another user sees the public fields (axe on /users/<id>)',
      profile.viewerSeesThePublicFields,
    );
    await test.step(
      'FR-PROF-01: the weaknesses and the e-mail are not shown or returned',
      profile.viewerDoesNotSeeWeaknessesOrEmail,
    );
  });
}

function githubTest(): void {
  test('FR-AUTH-01: sign in with GitHub through the double', async () => {
    let login = '';
    await test.step('FR-AUTH-01: "Sign in with GitHub" leads through the double back to the app', async () => {
      login = await auth.signInWithGithubDouble();
    });
    await test.step('FR-AUTH-03: the new user accepts the consent', auth.githubUserAcceptsConsent);
    await test.step('FR-AUTH-01: GET /me/github shows the GitHub login, settings show it too (axe)', () =>
      auth.githubLoginIsVisible(login));
  });
}

function deletionTest(): void {
  test('FR-AUTH-09: request the account deletion and cancel it from the mail', async () => {
    await test.step('FR-AUTH-09: /settings is accessible (axe)', auth.settingsPageIsAccessible);
    await test.step(
      'FR-AUTH-09: request the deletion (confirmation), sessions are revoked, a mail arrives',
      auth.requestDeletion,
    );
    await test.step(
      'FR-AUTH-09: the cancel link from the mail cancels the deletion (axe)',
      auth.cancelDeletionFromMail,
    );
    await test.step(
      'FR-AUTH-09: after a fresh sign-in the account is active and the profile is intact',
      auth.accountIsActiveAgain,
    );
  });
}

function rateLimitTest(): void {
  test('FR-AUTH-02, FR-AUTH-04: the sign-in page shows the 429 message with the retry hint', async () => {
    let email = '';
    await test.step('FR-AUTH-04: the 6th link request for one address within the hour is answered with 429', async () => {
      email = await auth.sixthLinkRequestIsRateLimited();
    });
    await test.step('FR-AUTH-04: the UI shows the error and the wait hint for that address (axe)', () =>
      auth.signInPageShowsRateLimit(email));
  });
}

test.describe('slice 2: auth and profile', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    const [ivan, guest, viewer, githubUser] = await Promise.all(
      [1, 2, 3, 4].map(() => openSession(browser)),
    );
    if (!ivan || !guest || !viewer || !githubUser) throw new Error('no browser sessions');
    setSessions({ ivan, guest, viewer, githubUser });
  });

  test.afterAll(async () => {
    const { ivan, guest, viewer, githubUser } = sessions();
    await Promise.all([ivan, guest, viewer, githubUser].map((s) => s.context.close()));
    setSessions(undefined);
    await stopGithubDouble();
  });

  signInTest();
  consentTest();
  profileTest();
  resumeTest();
  publicProfileTest();
  githubTest();
  deletionTest();
  rateLimitTest();
});
