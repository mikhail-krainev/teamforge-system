import { describe, expect, it } from 'vitest';
import { canonicalReleaseUrl } from './release-url.js';

describe('canonicalReleaseUrl (AF-02, R-1)', () => {
  it.each([
    ['https://Foo.App/X', 'https://foo.app/X'],
    ['https://foo%2eapp/x', 'https://foo.app/x'],
    ['https://fo%6f.app/', 'https://foo.app/'],
    ['https://ｆｏｏ.app/', 'https://foo.app/'],
    ['https://foo。app/', 'https://foo.app/'],
    ['https://пример.рф/', 'https://xn--e1afmkfd.xn--p1ai/'],
    ['  https://foo.app/a\t/b  ', 'https://foo.app/a/b'],
    ['https:\\\\foo.app\\x', 'https://foo.app/x'],
    ['https://foo.app', 'https://foo.app/'],
  ])('%j is stored as %s', (raw, stored) => {
    expect(canonicalReleaseUrl(raw)).toBe(stored);
  });

  it('text that is no address is kept as it is', () => {
    expect(canonicalReleaseUrl('not an address')).toBe('not an address');
  });
});
