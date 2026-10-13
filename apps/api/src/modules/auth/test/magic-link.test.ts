import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tokenLinkOf } from '../../../../test/fakes/mail.js';
import {
  countOf,
  expectProblem,
  expectRateLimited,
  logLinesWith,
} from '../../../../test/fixtures/assertions.js';
import { type BrowserSession, randomIp } from '../../../../test/fixtures/clients.js';
import { World } from '../../../../test/fixtures/world.js';
import { expectMatchesContract } from '../../../../test/helpers/contract.js';
import type { InjectResponse } from '../../../../test/helpers/http.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

describeInfra('S2 auth: magic link (FR-AUTH-02, FR-AUTH-04, FR-AUTH-06)', ['db', 'redis'], () => {
  let world: World;

  beforeAll(async () => {
    world = await World.start();
  });

  afterAll(async () => {
    if (!world) return;
    await world.close();
  });

  const requestLink = (
    session: BrowserSession,
    email: string,
    extra: Record<string, unknown> = {},
    ip = randomIp(),
  ): Promise<InjectResponse> =>
    session.post('/auth/sign-in/magic-link', { email, ...extra }, { idempotencyKey: null, ip });

  const confirm = (
    session: BrowserSession,
    token: string,
    extra: Record<string, unknown> = {},
    ip = randomIp(),
  ): Promise<InjectResponse> =>
    session.post('/auth/magic-link/confirm', { token, ...extra }, { idempotencyKey: null, ip });

  /** Requests a link and returns the token from the mail. */
  async function issueToken(email: string, ip = randomIp()): Promise<string> {
    const before = await world.mail.countTo(email);
    const response = await requestLink(world.browser(), email, {}, ip);
    expect(response.statusCode).toBe(200);
    const message = await world.mail.latestTo(email, { minCount: before + 1 });
    return tokenLinkOf(message).token;
  }

  describe('signInMagicLink', () => {
    it('FR-AUTH-02: a valid address gets 200 {status:true} and a mail with a one-time link', async () => {
      const email = world.email('link-ok');
      const response = await requestLink(world.browser(), email);
      expect(response.statusCode).toBe(200);
      expectMatchesContract('signInMagicLink', response);
      expect(response.json<{ status: boolean }>().status).toBe(true);
      const message = await world.mail.latestTo(email);
      expect(message.subject.length).toBeGreaterThan(0);
      expect(message.to).toContain(email);
    });

    it('FR-AUTH-02: the link points to the web confirm page with the token in the URL fragment, not in the query (SEC-09)', async () => {
      const email = world.email('link-fragment');
      await requestLink(world.browser(), email);
      const { link, token } = tokenLinkOf(await world.mail.latestTo(email));
      const url = new URL(link);
      expect(`${url.origin}${url.pathname}`).toBe(`${world.origin}/auth/confirm`);
      expect(url.search).toBe('');
      expect(url.hash).toBe(`#token=${token}`);
    });

    it('FR-AUTH-02: no password is asked anywhere in the mail', async () => {
      const email = world.email('link-nopass');
      await requestLink(world.browser(), email);
      const message = await world.mail.latestTo(email);
      expect(`${message.text}${message.html}`.toLowerCase()).not.toMatch(/password|парол/);
    });

    it('FR-AUTH-02: the link lives 15 minutes (C-30)', async () => {
      const email = world.email('link-ttl');
      await issueToken(email);
      const rows = await world.sql<{ minutes: number }[]>`
        SELECT round(extract(epoch FROM (expires_at - created_at)) / 60)::int AS minutes
          FROM auth.verification ORDER BY created_at DESC LIMIT 1`;
      expect(rows[0]?.minutes).toBe(15);
    });

    it('FR-AUTH-02: only a hash of the token is stored (SEC-09)', async () => {
      const email = world.email('link-hash');
      const token = await issueToken(email);
      const raw = await world.sql`SELECT value, identifier FROM auth.verification`;
      expect(JSON.stringify(raw)).not.toContain(token);
    });

    it('FR-AUTH-06: the answer is the same for an existing and for an unknown address (no enumeration)', async () => {
      const known = await world.createUser('link-known');
      const unknownEmail = world.email('link-unknown');
      const a = await requestLink(world.browser(), known.email);
      const b = await requestLink(world.browser(), unknownEmail);
      expect(a.statusCode).toBe(b.statusCode);
      expect(a.json()).toEqual(b.json());
      await world.mail.latestTo(known.email);
      await world.mail.latestTo(unknownEmail);
    });

    it('FR-AUTH-06 / S2CR-07: existing, alias and unknown addresses get the same status, body and headers; exactly one mail each, never to the alias', async () => {
      // A local part of its own: the it.each cases below use a.b<runId>, which normalizes to the same mailbox.
      const stored = `e.n${world.runId}@gmail.com`;
      const alias = `en${world.runId}+x@gmail.com`;
      const unknown = world.email('enum-unknown');
      await world.signIn(stored);
      const baseStored = await world.mail.countTo(stored);

      const existing = await requestLink(world.browser(), stored);
      await world.mail.latestTo(stored, { minCount: baseStored + 1 });
      const viaAlias = await requestLink(world.browser(), alias);
      await world.mail.latestTo(stored, { minCount: baseStored + 2 });
      const fresh = await requestLink(world.browser(), unknown);
      await world.mail.latestTo(unknown);

      for (const other of [viaAlias, fresh]) {
        expect(other.statusCode).toBe(existing.statusCode);
        expect(other.body).toBe(existing.body);
        expect(other.headers['content-type']).toBe(existing.headers['content-type']);
      }
      expect(existing.json()).toEqual({ status: true });
      // The alias request was queued before the unknown one and has been delivered by now.
      expect(await world.mail.countTo(stored)).toBe(baseStored + 2);
      expect(await world.mail.countTo(alias)).toBe(0);
      expect(await world.mail.countTo(unknown)).toBe(1);
    });

    it.each([
      ['an absolute URL', 'https://evil.example/steal'],
      ['a protocol-relative URL', '//evil.example'],
      ['a backslash trick', '/\\evil.example'],
      ['a javascript: URL', 'javascript:alert(1)'],
    ])('FR-AUTH-02: callbackURL as %s -> 400 (SEC-08)', async (_name, callbackURL) => {
      const email = world.email('link-cb');
      const response = await requestLink(world.browser(), email, { callbackURL });
      expect(response.statusCode).toBe(400);
      expectMatchesContract('signInMagicLink', response);
      expect(await world.mail.countTo(email)).toBe(0);
    });

    it.each([
      ['not an address', 'not-an-email'],
      ['an empty string', ''],
      ['too long', `${'a'.repeat(250)}@example.test`],
    ])('FR-AUTH-02: an e-mail that is %s -> 400', async (_name, email) => {
      const response = await requestLink(world.browser(), email);
      expect(response.statusCode).toBe(400);
      expectMatchesContract('signInMagicLink', response);
    });

    it('FR-AUTH-02: a body without e-mail or with extra fields -> 400', async () => {
      const session = world.browser();
      expect(
        (await session.post('/auth/sign-in/magic-link', {}, { idempotencyKey: null })).statusCode,
      ).toBe(400);
      expect(
        (await requestLink(session, world.email('link-extra'), { admin: true })).statusCode,
      ).toBe(400);
    });

    it('FR-AUTH-06: a disposable domain is refused (422) before any mail is sent', async () => {
      const email = `${world.runId}@mailinator.com`;
      const response = await requestLink(world.browser(), email);
      expect(response.statusCode).toBe(422);
      expectMatchesContract('signInMagicLink', response);
      expect(await world.mail.countTo(email)).toBe(0);
    });
  });

  describe('e-mail normalization (FR-AUTH-06)', () => {
    const cases = [
      ['gmail: dots and +tag', (id: string) => [`a.b${id}+x@gmail.com`, `ab${id}@gmail.com`]],
      [
        'yandex: other domain of the family',
        (id: string) => [`ivan-${id}@yandex.ru`, `ivan-${id}@ya.ru`],
      ],
      [
        'yandex: dot equals hyphen, +tag dropped',
        (id: string) => [`ivan-p${id}@yandex.ru`, `ivan.p${id}+news@yandex.com`],
      ],
      [
        'mail.ru: other domain of the family, +tag dropped',
        (id: string) => [`olga${id}@mail.ru`, `olga${id}+x@inbox.ru`],
      ],
    ] as const;

    it.each(cases)(
      'FR-AUTH-06 / S2SEC-02: %s -> the second spelling answers like an unknown address (200 {status:true}), the link goes to the stored address, no second user',
      async (_name, pair) => {
        const [first = '', alias = ''] = pair(world.runId);
        await world.signIn(first);
        const unknown = await requestLink(world.browser(), world.email('alias-unknown'));
        const beforeStored = await world.mail.countTo(first);
        const beforeAlias = await world.mail.countTo(alias);
        const response = await requestLink(world.browser(), alias);
        expect(response.statusCode).toBe(unknown.statusCode);
        expect(response.json()).toEqual(unknown.json());
        expectMatchesContract('signInMagicLink', response);
        await world.mail.latestTo(first, { minCount: beforeStored + 1 });
        expect(await world.mail.countTo(alias)).toBe(beforeAlias);
        const users = await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM auth."user"
           WHERE email_normalized = (SELECT email_normalized FROM auth."user" WHERE email = ${first})`);
        expect(users).toBe(1);
      },
    );

    it('FR-AUTH-06: only the letter case differs -> the same mailbox signs in as the same user (spec: lower case is part of the key)', async () => {
      const email = world.email('case-only');
      await world.signIn(email);
      const idBefore = await world.userIdByEmail(email);
      await world.signIn(email.toUpperCase());
      expect(await world.userIdByEmail(email)).toBe(idBefore);
    });

    it('FR-AUTH-06: the same spelling signs in again as the same user (no new record)', async () => {
      const email = world.email('same-again');
      await world.signIn(email);
      const idBefore = await world.userIdByEmail(email);
      await world.signIn(email);
      expect(await world.userIdByEmail(email)).toBe(idBefore);
    });
  });

  describe('verifyMagicLink', () => {
    it('FR-AUTH-02: a valid token signs the user in: 200 with redirectTo and a session cookie', async () => {
      const email = world.email('verify-ok');
      const token = await issueToken(email);
      const session = world.browser();
      const response = await confirm(session, token);
      expect(response.statusCode).toBe(200);
      expectMatchesContract('verifyMagicLink', response);
      expect(response.json<{ redirectTo: string }>().redirectTo).toMatch(/^\//);
      expect(session.cookies.size).toBeGreaterThan(0);
      const me = await session.get('/v1/me');
      expect(me.statusCode).toBe(200);
      expect(me.json<{ consentRequired: boolean }>().consentRequired).toBe(true);
    });

    it('FR-AUTH-02: callbackURL is returned as redirectTo when it is a relative path', async () => {
      const email = world.email('verify-redirect');
      const token = await issueToken(email);
      const response = await confirm(world.browser(), token, { callbackURL: '/profile' });
      expect(response.json<{ redirectTo: string }>().redirectTo).toBe('/profile');
    });

    it('FR-AUTH-01: the session cookie is HttpOnly and SameSite=Lax', async () => {
      const email = world.email('verify-cookie');
      const token = await issueToken(email);
      const response = await confirm(world.browser(), token);
      const raw = response.headers['set-cookie'];
      const cookies = (Array.isArray(raw) ? raw : [String(raw)]).join('\n');
      expect(cookies).toMatch(/httponly/i);
      expect(cookies).toMatch(/samesite=lax/i);
    });

    it('FR-AUTH-06: the first sign-in creates one verified user with a normalized address and identity signals', async () => {
      const email = world.email('verify-user');
      await world.signIn(email);
      const rows = await world.sql<
        {
          email_verified: boolean;
          email_normalized: string;
          status: string;
          github_user_id: number | null;
        }[]
      >`SELECT email_verified, email_normalized, status, github_user_id FROM auth."user" WHERE email = ${email}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.email_verified).toBe(true);
      expect(rows[0]?.email_normalized).toBe(email.toLowerCase());
      expect(rows[0]?.status).toBe('active');
      expect(rows[0]?.github_user_id).toBeNull();
      const id = await world.userIdByEmail(email);
      const signals = await countOf(world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM auth.identity_signal WHERE user_id = ${id}`);
      expect(signals).toBeGreaterThanOrEqual(1);
    });

    it('FR-AUTH-02: the same token used a second time -> 401 INVALID_TOKEN', async () => {
      const email = world.email('verify-reuse');
      const token = await issueToken(email);
      expect((await confirm(world.browser(), token)).statusCode).toBe(200);
      const again = await confirm(world.browser(), token);
      expectProblem('verifyMagicLink', again, 401, 'INVALID_TOKEN');
    });

    it('FR-AUTH-02: an expired token -> 401 EXPIRED_TOKEN', async () => {
      const email = world.email('verify-expired');
      const token = await issueToken(email);
      await world.sql`
        UPDATE auth.verification SET expires_at = now() - interval '1 minute'
         WHERE identifier = ${email} OR value LIKE ${`%${email}%`}`;
      const response = await confirm(world.browser(), token);
      expectProblem('verifyMagicLink', response, 401, 'EXPIRED_TOKEN');
    });

    it('FR-AUTH-02: a token that was never issued -> 401 INVALID_TOKEN, no session', async () => {
      const session = world.browser();
      const response = await confirm(session, randomUUID().replaceAll('-', '') + 'x'.repeat(8));
      expectProblem('verifyMagicLink', response, 401, 'INVALID_TOKEN');
      expect(session.cookies.size).toBe(0);
    });

    it.each([
      ['too short (< 16)', 'short'],
      ['too long (> 256)', 'T'.repeat(257)],
    ])('FR-AUTH-02: a token that is %s -> 400', async (_name, token) => {
      const response = await confirm(world.browser(), token);
      expect(response.statusCode).toBe(400);
      expectMatchesContract('verifyMagicLink', response);
    });

    it('FR-AUTH-02: a body without token -> 400', async () => {
      const response = await world
        .browser()
        .post('/auth/magic-link/confirm', {}, { idempotencyKey: null });
      expect(response.statusCode).toBe(400);
    });

    it('FR-AUTH-02: callbackURL on confirm is validated as well (SEC-08)', async () => {
      const email = world.email('verify-cb');
      const token = await issueToken(email);
      const response = await confirm(world.browser(), token, {
        callbackURL: 'https://evil.example',
      });
      expect(response.statusCode).toBe(400);
    });

    it('FR-AUTH-02: a token sent as a query parameter or in the URL of a GET is not accepted (SEC-09)', async () => {
      const email = world.email('verify-get');
      const token = await issueToken(email);
      const session = world.browser();
      const viaGet = await session.get(`/auth/magic-link/confirm?token=${token}`);
      expect(viaGet.statusCode).not.toBe(200);
      expect(session.cookies.size).toBe(0);
      // the token is still good for the proper POST (a scanner that opened the link did not burn it)
      expect((await confirm(world.browser(), token)).statusCode).toBe(200);
    });
  });

  describe('secrets in logs (SEC-07)', () => {
    it('FR-AUTH-02: the token never appears in the application log', async () => {
      const email = world.email('log-token');
      const token = await issueToken(email);
      await confirm(world.browser(), token);
      await confirm(world.browser(), token);
      expect(logLinesWith(world.logs, token)).toEqual([]);
    });
  });

  describe('rate limits (FR-AUTH-04)', () => {
    it('FR-AUTH-04: C-31 allows 5 link requests per hour for one address, the 6th -> 429 with Retry-After and no mail', async () => {
      const email = world.email('rl-address');
      for (let i = 0; i < 5; i += 1) {
        expect((await requestLink(world.browser(), email, {}, randomIp())).statusCode).toBe(200);
      }
      const sixth = await requestLink(world.browser(), email, {}, randomIp());
      expectRateLimited('signInMagicLink', sixth);
      await world.mail.latestTo(email, { minCount: 5 });
      expect(await world.mail.countTo(email)).toBe(5);
    });

    it('FR-AUTH-04: the address limit counts the normalized spelling (upper case does not reset it)', async () => {
      const email = world.email('rl-case');
      for (let i = 0; i < 5; i += 1) {
        const spelled = i % 2 === 0 ? email : email.toUpperCase();
        expect((await requestLink(world.browser(), spelled, {}, randomIp())).statusCode).toBe(200);
      }
      expectRateLimited(
        'signInMagicLink',
        await requestLink(world.browser(), email, {}, randomIp()),
      );
    });

    it('FR-AUTH-04: C-31 allows 20 requests per hour from one IP even for different addresses, the 21st -> 429', async () => {
      const ip = randomIp();
      for (let i = 0; i < 20; i += 1) {
        const response = await requestLink(world.browser(), world.email(`rl-ip-${i}`), {}, ip);
        expect(response.statusCode, `request ${i + 1}`).toBe(200);
      }
      const last = await requestLink(world.browser(), world.email('rl-ip-last'), {}, ip);
      expectRateLimited('signInMagicLink', last);
    });

    it('FR-AUTH-04: the limit of one IP does not hit another IP', async () => {
      const ip = randomIp();
      for (let i = 0; i < 20; i += 1)
        await requestLink(world.browser(), world.email(`rl-iso-${i}`), {}, ip);
      const other = await requestLink(world.browser(), world.email('rl-iso-other'), {}, randomIp());
      expect(other.statusCode).toBe(200);
    });

    it('FR-AUTH-04: forged left-hand entries of X-Forwarded-For do not buy a fresh IP limit (only the last untrusted hop counts, SEC-16)', async () => {
      const hop = randomIp();
      for (let i = 0; i < 20; i += 1) {
        const forged = `203.0.113.${i + 1}, ${hop}`;
        const response = await requestLink(world.browser(), world.email(`rl-xff-${i}`), {}, forged);
        expect(response.statusCode, `request ${i + 1}`).toBe(200);
      }
      const last = await requestLink(
        world.browser(),
        world.email('rl-xff-last'),
        {},
        `203.0.113.250, ${hop}`,
      );
      expectRateLimited('signInMagicLink', last);
    });

    it('FR-AUTH-04: C-32 allows 10 sign-in attempts per 15 minutes per IP, the 11th -> 429 with Retry-After', async () => {
      const ip = randomIp();
      for (let i = 0; i < 10; i += 1) {
        const attempt = await confirm(
          world.browser(),
          `wrong-token-${i}-${'x'.repeat(20)}`,
          {},
          ip,
        );
        expect(attempt.statusCode, `attempt ${i + 1}`).toBe(401);
      }
      const eleventh = await confirm(world.browser(), `wrong-token-11-${'x'.repeat(20)}`, {}, ip);
      expectRateLimited('verifyMagicLink', eleventh);
    });

    it('FR-AUTH-04: a valid token from an IP over the C-32 limit is refused too (429), the token stays usable elsewhere', async () => {
      const email = world.email('rl-valid');
      const token = await issueToken(email);
      const ip = randomIp();
      for (let i = 0; i < 10; i += 1)
        await confirm(world.browser(), `wrong-${i}-${'y'.repeat(24)}`, {}, ip);
      expectRateLimited('verifyMagicLink', await confirm(world.browser(), token, {}, ip));
      expect((await confirm(world.browser(), token, {}, randomIp())).statusCode).toBe(200);
    });
  });
});
