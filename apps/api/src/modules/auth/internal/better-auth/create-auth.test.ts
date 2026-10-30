import { describe, expect, it } from 'vitest';
import { usesSecureCookies } from './create-auth.js';

describe('usesSecureCookies', () => {
  it('marks cookies Secure on an https auth origin', () => {
    expect(usesSecureCookies({ BETTER_AUTH_URL: 'https://teamforge.example' })).toBe(true);
  });

  it('leaves them plain on http://localhost, where Safari drops Secure cookies (docs/local-run.md)', () => {
    expect(usesSecureCookies({ BETTER_AUTH_URL: 'http://localhost:3000' })).toBe(false);
  });
});
