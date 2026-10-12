import { describe, expect, it } from 'vitest';
import { decideUxRedirect, hasSessionCookie } from './ux-redirect';

describe('decideUxRedirect', () => {
  it('sends a guest from a protected page to sign-in with the way back', () => {
    expect(decideUxRedirect('/profile', '', false)).toEqual({
      pathname: '/sign-in',
      search: '?next=%2Fprofile',
    });
    expect(decideUxRedirect('/users/abc', '?x=1', false)?.search).toBe(
      '?next=%2Fusers%2Fabc%3Fx%3D1',
    );
  });

  it('lets signed-in visitors and public pages through', () => {
    expect(decideUxRedirect('/profile', '', true)).toBeNull();
    expect(decideUxRedirect('/sign-in', '', false)).toBeNull();
    expect(decideUxRedirect('/auth/confirm', '', false)).toBeNull();
    expect(decideUxRedirect('/profiles-of-others', '', false)).toBeNull();
  });
});

describe('hasSessionCookie', () => {
  it('accepts the plain and the __Secure- cookie name', () => {
    expect(hasSessionCookie((n) => n === '__Secure-better-auth.session_token')).toBe(true);
    expect(hasSessionCookie((n) => n === 'better-auth.session_token')).toBe(true);
    expect(hasSessionCookie(() => false)).toBe(false);
  });
});
