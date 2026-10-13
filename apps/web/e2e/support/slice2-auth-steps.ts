import { expect } from '@playwright/test';
import { apiGet, type Me } from './api';
import { signInContext, uniqueEmail } from './auth';
import { expectNoSeriousA11yViolations } from './axe';
import { githubDouble, githubIdentity, routeGithubDoubleToLoopback } from './github';
import {
  CANCEL_LINK_PATH,
  DELETION_SUBJECT,
  mailAfter,
  mailSnapshot,
  onWebOrigin,
  SIGN_IN_LINK_PATH,
  SIGN_IN_SUBJECT,
  tokenLink,
} from './mail';
import {
  cancelDeletionUi,
  confirmUi,
  consentUi,
  profileUi,
  ROUTES,
  settingsUi,
  signInUi,
} from './slice2-ui';
import {
  completeSignInLink,
  myProfile,
  PROFILE,
  sessions,
  WEB_ORIGIN,
  world,
} from './slice2-world';

/** Steps of the sign-in, consent, GitHub and account-deletion parts of the scenario. */

export async function signInPageIsAccessible(): Promise<void> {
  const { page } = sessions().ivan;
  await page.goto(ROUTES.signIn);
  await expect(signInUi.heading(page)).toBeVisible();
  await expect(signInUi.github(page)).toBeVisible();
  await expectNoSeriousA11yViolations(page);
}

export async function requestMagicLink(): Promise<void> {
  const { page } = sessions().ivan;
  const seen = await mailSnapshot(world.ivanEmail);
  await signInUi.email(page).fill(world.ivanEmail);
  await signInUi.requestLink(page).click();
  await expect(signInUi.sent(page)).toBeVisible();
  const mail = await mailAfter(world.ivanEmail, seen, SIGN_IN_SUBJECT);
  world.signInLink = tokenLink(mail, SIGN_IN_LINK_PATH).link;
  const url = new URL(world.signInLink);
  expect(url.hash).toMatch(/^#token=.{16,}/);
  expect(url.search, 'the token never travels in the query string').not.toContain('token');
}

export async function confirmWithoutTokenIsReported(): Promise<void> {
  const { page } = sessions().ivan;
  await page.goto(ROUTES.confirm);
  await expect(confirmUi.missingToken(page)).toBeVisible();
  await expectNoSeriousA11yViolations(page);
}

export async function openLinkAndSignIn(): Promise<void> {
  const { page, context } = sessions().ivan;
  await completeSignInLink(page, world.signInLink);
  const me = await apiGet<Me>(context.request, '/v1/me');
  expect(me.status, me.text).toBe(200);
  expect(me.body.status).toBe('active');
  expect(me.body.consentRequired, 'a new user has not accepted the consent yet').toBe(true);
  world.ivanId = me.body.id;
  const cookies = await context.cookies();
  expect(
    cookies.some((c) => c.httpOnly && c.sameSite === 'Lax'),
    'session cookie: HttpOnly, SameSite=Lax',
  ).toBe(true);
}

export async function linkCannotBeUsedTwice(): Promise<void> {
  const token = new URL(world.signInLink).hash.replace(/^#token=/, '');
  const again = await sessions().guest.context.request.post('/api/auth/magic-link/confirm', {
    data: { token },
    headers: { Origin: WEB_ORIGIN },
  });
  expect(again.status()).toBe(401);
}

export async function consentBlocksTheApp(): Promise<void> {
  const { page, context } = sessions().ivan;
  await page.goto(ROUTES.profile);
  await expect(consentUi.heading(page)).toBeVisible();
  await expect(profileUi.heading(page)).toHaveCount(0);
  const blocked = await apiGet<{ code: string }>(context.request, '/v1/me/profile');
  expect(blocked.status).toBe(403);
  expect(blocked.body.code).toBe('CONSENT_REQUIRED');
}

export async function consentScreenIsAccessible(): Promise<void> {
  const { page } = sessions().ivan;
  await expect(consentUi.text(page)).toContainText(/github/i);
  await expectNoSeriousA11yViolations(page);
}

export async function acceptConsentInUi(): Promise<void> {
  const { page, context } = sessions().ivan;
  await consentUi.accept(page).click();
  await expect(profileUi.heading(page)).toBeVisible();
  const me = await apiGet<Me>(context.request, '/v1/me');
  expect(me.body.consentRequired).toBe(false);
}

export async function signInWithGithubDouble(): Promise<string> {
  const { page, context } = sessions().githubUser;
  const double = await githubDouble();
  const identity = githubIdentity(`e2e-${Date.now()}`);
  await routeGithubDoubleToLoopback(context);
  double.nextLogin(identity);
  await page.goto(ROUTES.signIn);
  await signInUi.github(page).click();
  await page.waitForURL(
    (url) =>
      url.origin === WEB_ORIGIN &&
      !url.pathname.startsWith(ROUTES.signIn) &&
      !url.pathname.startsWith('/api'),
    { timeout: 60_000 },
  );
  expect(double.requests.some((r) => r.path === '/login/oauth/access_token')).toBe(true);
  return identity.login;
}

export async function githubUserAcceptsConsent(): Promise<void> {
  const { page } = sessions().githubUser;
  await page.goto(ROUTES.profile);
  await expect(consentUi.heading(page)).toBeVisible();
  await consentUi.accept(page).click();
  await expect(profileUi.heading(page)).toBeVisible();
}

export async function githubLoginIsVisible(login: string): Promise<void> {
  const { page, context } = sessions().githubUser;
  const me = await apiGet<Me>(context.request, '/v1/me');
  expect(me.status, me.text).toBe(200);
  expect(me.body.id).not.toBe(world.ivanId);
  const github = await apiGet<{ linked: boolean; login?: string | null }>(
    context.request,
    '/v1/me/github',
  );
  expect(github.body.linked).toBe(true);
  expect(github.body.login).toBe(login);
  await page.goto(ROUTES.settings);
  await expect(settingsUi.githubLinked(page, login)).toBeVisible();
  await expectNoSeriousA11yViolations(page);
}

export async function settingsPageIsAccessible(): Promise<void> {
  const { page } = sessions().ivan;
  await page.goto(ROUTES.settings);
  await expect(settingsUi.heading(page)).toBeVisible();
  await expectNoSeriousA11yViolations(page);
}

export async function requestDeletion(): Promise<void> {
  const { page, context } = sessions().ivan;
  const seen = await mailSnapshot(world.ivanEmail);
  await settingsUi.openDeletion(page).click();
  await settingsUi.deletionCheck(page).check();
  await settingsUi.deletionConfirm(page).click();
  await expect(settingsUi.deletionRequested(page)).toBeVisible();
  const mail = await mailAfter(world.ivanEmail, seen, DELETION_SUBJECT);
  world.cancelLink = tokenLink(mail, CANCEL_LINK_PATH).link;
  // S2CR-02: the worker revokes the sessions when it handles the "request created" event.
  await expect
    .poll(async () => (await apiGet(context.request, '/v1/me')).status, {
      message: 'sessions are revoked by the event consumer',
    })
    .toBe(401);
}

export async function cancelDeletionFromMail(): Promise<void> {
  const { page } = sessions().guest;
  await page.goto(onWebOrigin(world.cancelLink));
  await expect(cancelDeletionUi.heading(page)).toBeVisible();
  await expect(cancelDeletionUi.done(page)).toBeVisible();
  await expectNoSeriousA11yViolations(page);
}

export async function accountIsActiveAgain(): Promise<void> {
  const { context } = sessions().ivan;
  const again = await signInContext(context, { email: world.ivanEmail, acceptConsent: false });
  expect(again.id).toBe(world.ivanId);
  expect(again.me.status).toBe('active');
  expect((await myProfile(context)).displayName).toBe(PROFILE.name);
}

export async function sixthLinkRequestIsRateLimited(): Promise<string> {
  const email = uniqueEmail('limit');
  const statuses: number[] = [];
  let retryAfter = '';
  for (let i = 0; i < 6; i += 1) {
    const response = await sessions().guest.context.request.post('/api/auth/sign-in/magic-link', {
      data: { email, callbackURL: ROUTES.profile },
      headers: { Origin: WEB_ORIGIN },
    });
    statuses.push(response.status());
    retryAfter = response.headers()['retry-after'] ?? retryAfter;
  }
  expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  expect(Number(retryAfter), 'Retry-After in seconds').toBeGreaterThan(0);
  return email;
}

export async function signInPageShowsRateLimit(email: string): Promise<void> {
  const { page } = sessions().guest;
  await page.goto(ROUTES.signIn);
  await signInUi.email(page).fill(email);
  await signInUi.requestLink(page).click();
  await expect(signInUi.rateLimited(page)).toBeVisible();
  await expect(signInUi.retryHint(page)).toBeVisible();
  await expect(signInUi.requestLink(page)).toBeDisabled();
  await expectNoSeriousA11yViolations(page);
}
