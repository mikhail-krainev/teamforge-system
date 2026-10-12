/**
 * Shared shapes of the mail doubles (docs/plan.md, "Фикстуры": SMTP is replaced by Mailpit or by the
 * in-process SMTP sink). Self-contained on purpose: it is imported by API tests and by Playwright.
 */
export interface MailMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  receivedAt: Date;
}

export interface WaitOptions {
  /** Wait until at least this many messages to the address exist (default 1). */
  minCount?: number;
  timeoutMs?: number;
}

/** A place where the tests read outgoing mail from: Mailpit (Playwright, compose) or the SMTP sink. */
export interface MailInbox {
  /** The newest message sent to the address; waits (polling, no fixed sleeps) until it arrives. */
  latestTo(address: string, options?: WaitOptions): Promise<MailMessage>;
  allTo(address: string): Promise<MailMessage[]>;
  countTo(address: string): Promise<number>;
}

const URL_PATTERN = /https?:\/\/[^\s"'<>)]+/g;

/** Every absolute http(s) link in the text and HTML bodies of a message, in order, without repeats. */
export function linksOf(message: Pick<MailMessage, 'text' | 'html'>): string[] {
  const found = new Set<string>();
  for (const source of [message.text, message.html.replaceAll('&amp;', '&')]) {
    for (const match of source.matchAll(URL_PATTERN)) found.add(match[0].replace(/[.,;]+$/, ''));
  }
  return [...found];
}

/**
 * The one-time token of a link: from the fragment (`#token=...`, the magic-link format of
 * docs/architecture.md 13.8) or from a query parameter (`?token=...`). Throws if there is none.
 */
export function tokenFromLink(link: string, param = 'token'): string {
  const url = new URL(link);
  const fromFragment = new URLSearchParams(url.hash.replace(/^#/, '')).get(param);
  const token = fromFragment ?? url.searchParams.get(param);
  if (!token) throw new Error(`no "${param}" in link ${url.origin}${url.pathname}`);
  return token;
}

/** The first link of the message that carries a token (the sign-in link, the cancel-deletion link). */
export function tokenLinkOf(
  message: MailMessage,
  param = 'token',
): { link: string; token: string } {
  for (const link of linksOf(message)) {
    try {
      return { link, token: tokenFromLink(link, param) };
    } catch {
      // not a token link
    }
  }
  throw new Error(`message "${message.subject}" has no link with a "${param}" parameter`);
}

export async function pollUntil<T>(
  check: () => Promise<T | undefined>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what}: timed out after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
