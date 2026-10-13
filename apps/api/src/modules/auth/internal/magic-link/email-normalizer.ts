const GMAIL = new Set(['gmail.com', 'googlemail.com']);
const YANDEX = new Set([
  'yandex.ru',
  'ya.ru',
  'yandex.com',
  'yandex.by',
  'yandex.kz',
  'yandex.ua',
  'yandex.uz',
]);
const MAIL_RU = new Set(['mail.ru', 'inbox.ru', 'list.ru', 'bk.ru', 'internet.ru']);

function withoutTag(local: string): string {
  const plus = local.indexOf('+');
  return plus < 0 ? local : local.slice(0, plus);
}

function normalizedLocal(local: string, canonicalDomain: string): string {
  switch (canonicalDomain) {
    case 'gmail.com':
      return withoutTag(local).replaceAll('.', '');
    case 'yandex.ru':
      // Yandex treats a dot and a hyphen in the login as the same character.
      return withoutTag(local).replaceAll('.', '-');
    case 'mail.ru':
      return withoutTag(local);
    default:
      return local;
  }
}

function canonicalDomain(domain: string): string {
  if (GMAIL.has(domain)) return 'gmail.com';
  if (YANDEX.has(domain)) return 'yandex.ru';
  if (MAIL_RU.has(domain)) return 'mail.ru';
  return domain;
}

/**
 * The key by which one mailbox is recognised whatever its spelling (FR-AUTH-06, anti-abuse): lower
 * case, and for Gmail, Yandex and Mail.ru the aliases of the same mailbox collapse (dots, `+tag`,
 * sibling domains). Other providers only lose letter case. The result is never used as a delivery
 * address.
 */
export function normalizeEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 1) return lower;
  const domain = canonicalDomain(lower.slice(at + 1));
  return `${normalizedLocal(lower.slice(0, at), domain)}@${domain}`;
}

export function emailDomain(email: string): string {
  return email
    .trim()
    .toLowerCase()
    .slice(email.lastIndexOf('@') + 1);
}
