import { describe, expect, it, vi } from 'vitest';
import { readTokenFromFragment, safeRedirectPath, stripFragment } from './fragment';

const TOKEN = 'abcDEF0123456789_-.~xyz';

describe('readTokenFromFragment', () => {
  it('reads the token from #token=', () => {
    expect(readTokenFromFragment(`#token=${TOKEN}`)).toBe(TOKEN);
  });

  it('works without the leading # and next to other parameters', () => {
    expect(readTokenFromFragment(`foo=1&token=${TOKEN}`)).toBe(TOKEN);
  });

  it('returns null when the fragment is empty or has no token', () => {
    expect(readTokenFromFragment('')).toBeNull();
    expect(readTokenFromFragment('#')).toBeNull();
    expect(readTokenFromFragment('#other=1')).toBeNull();
  });

  it('rejects tokens that are too short, too long or use foreign characters', () => {
    expect(readTokenFromFragment('#token=short')).toBeNull();
    expect(readTokenFromFragment(`#token=${'a'.repeat(257)}`)).toBeNull();
    expect(readTokenFromFragment(`#token=${'a'.repeat(15)}<script>`)).toBeNull();
  });

  it('does not read the token from a query string', () => {
    expect(readTokenFromFragment(`?token=${TOKEN}`)).toBeNull();
  });
});

describe('stripFragment', () => {
  it('replaces the history entry with the path and query only', () => {
    const replaceState = vi.fn();
    stripFragment({
      location: { pathname: '/auth/confirm', search: '?a=1' },
      history: { replaceState },
    } as unknown as Window);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/auth/confirm?a=1');
  });
});

describe('safeRedirectPath', () => {
  it('keeps same-app relative paths', () => {
    expect(safeRedirectPath('/profile')).toBe('/profile');
    expect(safeRedirectPath('/users/1?tab=a')).toBe('/users/1?tab=a');
  });

  it('falls back for absolute, protocol-relative and script targets', () => {
    const bad = [
      'https://evil.example',
      '//evil.example',
      '/\\evil',
      'javascript:alert(1)',
      '',
      undefined,
    ];
    for (const value of bad) expect(safeRedirectPath(value)).toBe('/profile');
    expect(safeRedirectPath('//x', '/home')).toBe('/home');
  });
});
