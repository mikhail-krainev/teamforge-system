import { describe, expect, it } from 'vitest';
import { isDisposableDomain } from './disposable-domains.js';
import { normalizeEmail } from './email-normalizer.js';

describe('normalizeEmail (FR-AUTH-06)', () => {
  it.each([
    ['A.B+x@Gmail.com', 'ab@gmail.com'],
    ['ab@googlemail.com', 'ab@gmail.com'],
    ['ivan.p+news@ya.ru', 'ivan-p@yandex.ru'],
    ['ivan-p@yandex.com', 'ivan-p@yandex.ru'],
    ['olga+x@inbox.ru', 'olga@mail.ru'],
    ['Some.One+tag@example.org', 'some.one+tag@example.org'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });
});

describe('isDisposableDomain', () => {
  it('knows listed domains and their subdomains, not ordinary ones', () => {
    expect(isDisposableDomain('mailinator.com')).toBe(true);
    expect(isDisposableDomain('Foo.Mailinator.com')).toBe(true);
    expect(isDisposableDomain('gmail.com')).toBe(false);
    expect(isDisposableDomain('notmailinator.com')).toBe(false);
  });
});
