/** Throw-away mailbox providers (FR-AUTH-06). A subdomain of a listed domain counts as well. */
const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamailblock.com',
  'sharklasers.com',
  'grr.la',
  '10minutemail.com',
  '10minutemail.net',
  'temp-mail.org',
  'temp-mail.ru',
  'tempmail.com',
  'tempmail.net',
  'tempmailo.com',
  'throwawaymail.com',
  'yopmail.com',
  'yopmail.net',
  'trashmail.com',
  'trashmail.net',
  'getnada.com',
  'dispostable.com',
  'maildrop.cc',
  'fakeinbox.com',
  'mailnesia.com',
  'mintemail.com',
  'mohmal.com',
  'emailondeck.com',
  'moakt.com',
  'burnermail.io',
  'spamgourmet.com',
  'mytemp.email',
  'mail.tm',
  'discard.email',
  'dropmail.me',
]);

export function isDisposableDomain(domain: string): boolean {
  const labels = domain.toLowerCase().split('.');
  for (let start = 0; start < labels.length - 1; start += 1) {
    if (DISPOSABLE_DOMAINS.has(labels.slice(start).join('.'))) return true;
  }
  return false;
}
