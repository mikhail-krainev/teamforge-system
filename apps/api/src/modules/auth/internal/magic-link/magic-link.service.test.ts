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

/**
 * Which address the link goes to. That the answer does not reveal whether a mailbox is registered
 * (status, body, number and recipient of mails) is proved over HTTP against the real stack in
 * `src/modules/auth/test/magic-link.test.ts` (S2CR-07): a unit test on mocks cannot prove it.
 */
describe('S2SEC-02: signInMagicLink target address', () => {
  const run = async (stored: string | undefined, email: string) => {
    const { service, signInMagicLink } = build(stored);
    await service.request(request, email);
    return signInMagicLink;
  };

  it('sends the link to the address stored with the account, not to the alias', async () => {
    const signInMagicLink = await run('a.b@gmail.com', 'ab+x@gmail.com');
    expect(signInMagicLink).toHaveBeenCalledOnce();
    expect(signInMagicLink).toHaveBeenCalledWith(
      expect.objectContaining({ body: { email: 'a.b@gmail.com' } }),
    );
  });

  it('an unknown address gets the link at the address it typed', async () => {
    const signInMagicLink = await run(undefined, 'new@example.test');
    expect(signInMagicLink).toHaveBeenCalledWith(
      expect.objectContaining({ body: { email: 'new@example.test' } }),
    );
  });
});
