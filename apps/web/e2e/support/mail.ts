import type { MailMessage } from '../../../api/test/fakes/mail';
import { linksOf } from '../../../api/test/fakes/mail';
import { MailpitClient } from '../../../api/test/fakes/mailpit';
import { E2E_ENV, E2E_WEB_URL } from './stack';

// The Mailpit client and the link helpers are shared with the API tests (apps/api/test/fakes).
export { linksOf, tokenFromLink } from '../../../api/test/fakes/mail';
export type { MailMessage };

/** Mailpit of the e2e compose project (UI/API port from E2E_ENV; SMTP is 11025). */
export const mailbox = new MailpitClient(`http://localhost:${E2E_ENV.MAILPIT_UI_PORT}`);

/**
 * Re-roots an absolute link from a mail on the web origin of the e2e stack, keeping path, query and
 * fragment. The mail carries whatever APP_ORIGIN the api was configured with; the browser must use
 * the published web port.
 */
export function onWebOrigin(link: string): string {
  const url = new URL(link);
  return `${E2E_WEB_URL}${url.pathname}${url.search}${url.hash}`;
}

/** The first link of the message whose path matches `path` and that carries a `token` parameter. */
export function tokenLink(message: MailMessage, path: RegExp): { link: string; token: string } {
  for (const link of linksOf(message)) {
    const url = new URL(link);
    if (!path.test(url.pathname)) continue;
    const token =
      new URLSearchParams(url.hash.replace(/^#/, '')).get('token') ?? url.searchParams.get('token');
    if (token) return { link, token };
  }
  throw new Error(
    `message "${message.subject}" has no token link on a path matching ${String(path)}`,
  );
}

/**
 * Waits for one more message to `address` than there were when `before` was taken. Use it as
 * `const before = await mailbox.countTo(a); ...trigger the mail...; await mailAfter(a, before)`.
 */
export function mailAfter(
  address: string,
  before: number,
  timeoutMs = 30_000,
): Promise<MailMessage> {
  return mailbox.latestTo(address, { minCount: before + 1, timeoutMs });
}

/** The magic-link mail path (docs/architecture.md 13.8) and the deletion-cancel mail path (13.9). */
export const SIGN_IN_LINK_PATH = /^\/auth\/confirm\/?$/;
export const CANCEL_LINK_PATH = /cancel|deletion/i;
