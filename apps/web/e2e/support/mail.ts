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

/** Subjects of the mails the scenarios wait for (apps/api: magic-link-mail.ts, deletion-mail.ts). */
export const SIGN_IN_SUBJECT = 'Вход в Корнер';
export const DELETION_SUBJECT = 'Запрос на удаление учётной записи Корнера';

/** Ids of the mails to `address` that exist now; take it before the action that triggers a mail. */
export async function mailSnapshot(address: string): Promise<ReadonlySet<string>> {
  return new Set((await mailbox.allTo(address)).map((m) => m.id));
}

/**
 * Waits (polling) for a mail to `address` that is not in `seen` and has the given subject. The mail
 * is chosen by purpose, never as "the newest": some mails are sent asynchronously by outbox consumers
 * (deletion notice, S2CR-02), and mails created within the same second have no stable order.
 */
export async function mailAfter(
  address: string,
  seen: ReadonlySet<string>,
  subject: string,
  timeoutMs = 30_000,
): Promise<MailMessage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await mailbox.allTo(address)).find(
      (m) => !seen.has(m.id) && m.subject === subject,
    );
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`mail "${subject}" to ${address}: timed out after ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The magic-link mail path (docs/architecture.md 13.8) and the deletion-cancel mail path (13.9). */
export const SIGN_IN_LINK_PATH = /^\/auth\/confirm\/?$/;
export const CANCEL_LINK_PATH = /cancel|deletion/i;
