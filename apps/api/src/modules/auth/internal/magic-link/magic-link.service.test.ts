import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../../platform/db/db.module.js';
import type { RateLimiter } from '../../../../platform/ratelimit/rate-limiter.js';
import type { Auth } from '../better-auth/create-auth.js';
import { MagicLinkService } from './magic-link.service.js';

const request = { ip: '203.0.113.7', headers: {} } as unknown as FastifyRequest;

function build(stored: string | undefined) {
  const signInMagicLink = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { status: true };
  });
  const rows = stored === undefined ? [] : [{ email: stored }];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
  } as unknown as Database;
  const limiter = {
    enforce: vi.fn(async () => undefined),
    ipSubject: (ip: string) => `ip:${ip}`,
    emailSubject: (email: string) => `email:${email}`,
  } as unknown as RateLimiter;
  const auth = { api: { signInMagicLink } } as unknown as Auth;
  return { service: new MagicLinkService(auth, db, limiter), signInMagicLink };
}

describe('S2SEC-02: signInMagicLink does not reveal whether the mailbox is registered', () => {
  const timed = async (stored: string | undefined, email: string) => {
    const { service, signInMagicLink } = build(stored);
    const started = performance.now();
    const body = await service.request(request, email);
    return { body, ms: performance.now() - started, signInMagicLink };
  };

  it('answers an alias of an existing account exactly like an unknown address', async () => {
    const unknown = await timed(undefined, 'ab@gmail.com');
    const alias = await timed('a.b@gmail.com', 'ab+x@gmail.com');
    expect(alias.body).toEqual(unknown.body);
    expect(JSON.stringify(alias.body)).toBe(JSON.stringify(unknown.body));
    expect(Math.abs(alias.ms - unknown.ms)).toBeLessThan(250);
  });

  it('sends the link to the address stored with the account, not to the alias', async () => {
    const alias = await timed('a.b@gmail.com', 'ab+x@gmail.com');
    expect(alias.signInMagicLink).toHaveBeenCalledOnce();
    expect(alias.signInMagicLink).toHaveBeenCalledWith(
      expect.objectContaining({ body: { email: 'a.b@gmail.com' } }),
    );
  });

  it('an unknown address gets the link at the address it typed', async () => {
    const unknown = await timed(undefined, 'new@example.test');
    expect(unknown.signInMagicLink).toHaveBeenCalledWith(
      expect.objectContaining({ body: { email: 'new@example.test' } }),
    );
  });
});
