import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/config.js';
import { DomainError } from '../errors/domain-error.js';
import { OriginGuard } from './origin.guard.js';

const guard = new OriginGuard({ APP_ORIGIN: 'https://app.example.test' } as AppConfig);

function run(method: string, headers: Record<string, string>): boolean {
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ method, headers }) }),
  } as unknown as ExecutionContext;
  return guard.canActivate(context);
}

describe('OriginGuard (CSRF, architecture 13.10, SEC-24)', () => {
  const cookie = { cookie: 'better-auth.session_token=abc' };

  it('lets safe methods and cookie-less requests through', () => {
    expect(run('GET', { ...cookie, origin: 'https://evil.example' })).toBe(true);
    expect(run('POST', { origin: 'https://evil.example' })).toBe(true);
  });

  it('accepts a cookie request from APP_ORIGIN by Origin or by Referer', () => {
    expect(run('POST', { ...cookie, origin: 'https://app.example.test' })).toBe(true);
    expect(run('DELETE', { ...cookie, referer: 'https://app.example.test/profile?x=1' })).toBe(
      true,
    );
  });

  it.each([
    ['a foreign Origin', { origin: 'https://evil.example' }],
    ['a look-alike host', { origin: 'https://app.example.test.evil.example' }],
    ['another scheme', { origin: 'http://app.example.test' }],
    ['the "null" origin', { origin: 'null' }],
    ['neither Origin nor Referer', {}],
    ['an empty Origin', { origin: '' }],
  ])('refuses a cookie request with %s', (_name, headers) => {
    expect(() => run('POST', { ...cookie, ...headers })).toThrow(DomainError);
  });
});
