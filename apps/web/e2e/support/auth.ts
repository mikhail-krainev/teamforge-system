import { randomUUID } from 'node:crypto';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { apiGet, apiPost, type Me } from './api';
import { mailAfter, mailbox, SIGN_IN_LINK_PATH, tokenLink } from './mail';

export interface E2eUser {
  /** Address the magic link is requested for; unique per run (see `uniqueEmail`). */
  email: string;
  /** Accept the current consent text through the API right after sign-in (default true). */
  acceptConsent?: boolean;
  role?: 'member' | 'admin';
}

export interface SignedInUser {
  id: string;
  email: string;
  me: Me;
}

/** Unique, deliverable-looking address for one run (Mailpit accepts everything). */
export function uniqueEmail(label: string): string {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return `${label}-${stamp}@example.test`;
}

/** Asks for a sign-in link and returns the one-time token read from the mail in Mailpit. */
export async function requestMagicLinkToken(
  context: BrowserContext,
  email: string,
  callbackURL = '/profile',
): Promise<string> {
  const before = await mailbox.countTo(email);
  const sent = await apiPost(context.request, '/auth/sign-in/magic-link', { email, callbackURL });
  expect(sent.status, `magic link request for ${email}: ${sent.text}`).toBe(200);
  const message = await mailAfter(email, before);
  return tokenLink(message, SIGN_IN_LINK_PATH).token;
}

/** Accepts the current consent text through the API (fresh Idempotency-Key). */
export async function acceptConsentViaApi(context: BrowserContext): Promise<void> {
  const current = await apiGet<{ version: string; textHash: string }>(
    context.request,
    '/v1/consent/current',
  );
  expect(current.status, current.text).toBe(200);
  const accepted = await apiPost(
    context.request,
    '/v1/me/consents',
    { version: current.body.version, textHash: current.body.textHash },
    { 'Idempotency-Key': randomUUID() },
  );
  expect([200, 201], accepted.text).toContain(accepted.status);
}

/**
 * Signs a browser context in with a real magic link: request, read the mail from Mailpit, confirm
 * through `POST /api/auth/magic-link/confirm`. The session cookie lands in the context's cookie jar,
 * so every page of the context is signed in. Used for the second user and for repeat sign-ins; the
 * first user of the scenario signs in through the UI instead.
 */
export async function signInContext(context: BrowserContext, user: E2eUser): Promise<SignedInUser> {
  const token = await requestMagicLinkToken(context, user.email);
  const confirmed = await apiPost(context.request, '/auth/magic-link/confirm', { token });
  expect(confirmed.status, `magic link confirm: ${confirmed.text}`).toBe(200);
  if (user.acceptConsent !== false) await acceptConsentViaApi(context);
  const me = await apiGet<Me>(context.request, '/v1/me');
  expect(me.status, me.text).toBe(200);
  return { id: me.body.id, email: user.email, me: me.body };
}

/**
 * Sign-in helper for every scenario after slice 2 (plan, "Фикстуры"): a real session obtained
 * through the magic-link flow, not a Redis shortcut (the api owns sessions; there is no test-only
 * door). The page only needs to belong to the context that should be signed in.
 */
export function signIn(page: Page, user: E2eUser): Promise<SignedInUser> {
  return signInContext(page.context(), user);
}
