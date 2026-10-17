import { describe, expect, it } from 'vitest';
import { isStorableLink, linkStatusOf } from './link-policy.js';

describe('isStorableLink (SEC-05 at saving)', () => {
  it.each([
    'https://example.test/board',
    'https://example.test:443/board',
    'https://docs.example.com/a?b=c#d',
    'https://93.184.216.34/',
    'https://xn--80ak6aa92e.xn--p1ai/',
  ])('%s is stored', (link) => {
    expect(isStorableLink(link)).toBe(true);
  });

  it.each([
    'https://127.0.0.1/',
    'https://127.1.2.3/admin',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/',
    'https://172.16.0.9/',
    'https://172.31.255.255/',
    'https://192.168.1.1/',
    'https://100.64.0.1/',
    'https://0.0.0.0/',
    'https://224.0.0.1/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:7f00:1]/',
    'https://[fe80::1]/',
    'https://[2002:7f00:1::]/',
    'https://0x7f.0.0.1/',
    'https://2130706433/',
    'https://017700000001/',
    'https://user:pass@example.test/',
    'https://admin@example.test/',
    'https://example.test:8080/',
    'https://example.test:22/',
    'https://localhost/',
    'https://LOCALHOST./',
    'https://app.localhost/',
    'https://printer.local/',
    'https://db.internal/',
    'https://intranet/',
  ])('%s is refused', (link) => {
    expect(isStorableLink(link)).toBe(false);
  });

  it.each([
    'http://example.test/',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'ftp://example.test/file',
    'data:text/html,<script>alert(1)</script>',
    '//example.test/path',
    'not a url',
    '',
  ])('%s is not https', (link) => {
    expect(isStorableLink(link)).toBe(false);
  });
});

describe('linkStatusOf (the answer of the link-checker)', () => {
  it('2xx is ok', () => {
    expect(linkStatusOf({ ok: true, reason: null })).toBe('ok');
  });

  it.each(['BLOCKED_ADDRESS', 'BLOCKED_PORT'])(
    '%s is rejected: the blocking part of link_https',
    (reason) => {
      expect(linkStatusOf({ ok: false, reason })).toBe('rejected');
    },
  );

  it.each([
    'HTTP_STATUS',
    'TIMEOUT',
    'TLS_ERROR',
    'DNS_ERROR',
    'TOO_MANY_REDIRECTS',
    'TOO_SMALL',
    'PLACEHOLDER_TITLE',
  ])('%s is only a warning: broken', (reason) => {
    expect(linkStatusOf({ ok: false, reason })).toBe('broken');
  });
});
