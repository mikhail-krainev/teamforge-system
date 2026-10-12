import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tokenLinkOf } from '../../../../test/fakes/mail.js';
import { countOf, expectProblem } from '../../../../test/fixtures/assertions.js';
import { World } from '../../../../test/fixtures/world.js';
import { expectMatchesContract } from '../../../../test/helpers/contract.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

describeInfra(
  'S2 auth: sessions, sign-out and CSRF (FR-AUTH-07, FR-AUTH-01)',
  ['db', 'redis'],
  () => {
    let world: World;
    let secure: World;

    beforeAll(async () => {
      world = await World.start();
      secure = await World.start({ secureOrigins: true });
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
      await secure?.close();
    });

    describe('getSession', () => {
      it('FR-AUTH-07: without a session getSession answers 200 with null', async () => {
        const response = await world.anonymous().get('/auth/get-session');
        expect(response.statusCode).toBe(200);
        expectMatchesContract('getSession', response);
        expect(response.json()).toBeNull();
      });

      it('FR-AUTH-07: with the session cookie getSession returns the session of that user', async () => {
        const { user, session } = await world.signedIn('sess-get');
        const response = await session.get('/auth/get-session');
        expect(response.statusCode).toBe(200);
        expectMatchesContract('getSession', response);
        const body = response.json<{ user: { id: string }; session: Record<string, unknown> }>();
        expect(body.user.id).toBe(user.id);
        expect(JSON.stringify(body)).not.toContain('"token"');
      });

      it('FR-AUTH-07: a forged or garbage cookie is no session (null, not an error)', async () => {
        const session = world.browser();
        session.cookies.set('better-auth.session_token', 'garbage.value');
        const response = await session.get('/auth/get-session');
        expect(response.statusCode).toBe(200);
        expect(response.json()).toBeNull();
        expect((await session.get('/v1/me')).statusCode).toBe(401);
      });
    });

    describe('session storage (ADR-0009)', () => {
      it('FR-AUTH-07: the session lives in Redis only: auth.session stays empty', async () => {
        await world.signedIn('sess-redis');
        expect(
          await countOf(world.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM auth.session`),
        ).toBe(0);
      });

      it('FR-AUTH-07: another API instance accepts the same cookie (no process-local session state)', async () => {
        const { user, session } = await world.signedIn('sess-second-app');
        const second = await world.startSecondApp();
        const viaOther = world.browser(second);
        for (const [name, value] of session.cookies) viaOther.cookies.set(name, value);
        const response = await viaOther.get('/v1/me');
        expect(response.statusCode).toBe(200);
        expect(response.json<{ id: string }>().id).toBe(user.id);
      });
    });

    describe('signOut', () => {
      it('FR-AUTH-07: signOut answers 200 {success:true}, clears the cookie and ends the session', async () => {
        const { session } = await world.signedIn('sess-out');
        const response = await session.post('/auth/sign-out', undefined, { idempotencyKey: null });
        expect(response.statusCode).toBe(200);
        expectMatchesContract('signOut', response);
        expect(response.json<{ success: boolean }>().success).toBe(true);
        const cleared = [response.headers['set-cookie']].flat().join('\n');
        expect(cleared).toMatch(/max-age=0|expires=thu, 01 jan 1970/i);
      });

      it('FR-AUTH-07: the old cookie no longer works after signOut (401 on the API, null on getSession)', async () => {
        const { session } = await world.signedIn('sess-out-old');
        const cookie = session.cookieHeader();
        await session.post('/auth/sign-out', undefined, { idempotencyKey: null });
        const replay = world.browser();
        replay.cookies.clear();
        for (const pair of cookie.split('; ')) {
          const at = pair.indexOf('=');
          replay.cookies.set(pair.slice(0, at), pair.slice(at + 1));
        }
        expectProblem('getMe', await replay.get('/v1/me'), 401, 'UNAUTHENTICATED');
        expect((await replay.get('/auth/get-session')).json()).toBeNull();
      });

      it('FR-AUTH-07: signing out one session leaves the other sessions of the user alone', async () => {
        const { user, session: first } = await world.signedIn('sess-two');
        const second = await world.signIn(user.email);
        await first.post('/auth/sign-out', undefined, { idempotencyKey: null });
        expect((await second.get('/v1/me')).statusCode).toBe(200);
      });

      it('FR-AUTH-07: signOut without a session -> 401 UNAUTHENTICATED', async () => {
        const response = await world
          .anonymous()
          .post('/auth/sign-out', undefined, { idempotencyKey: null });
        expectProblem('signOut', response, 401, 'UNAUTHENTICATED');
      });
    });

    describe('cookie and CSRF (architecture 13.10)', () => {
      it('FR-AUTH-01: the session cookie is HttpOnly, Secure and SameSite=Lax on an https deployment', async () => {
        const email = secure.email('sess-cookie');
        const session = secure.browser();
        await session.post('/auth/sign-in/magic-link', { email }, { idempotencyKey: null });
        const token = tokenLinkOf(await secure.mail.latestTo(email)).token;
        const response = await session.post(
          '/auth/magic-link/confirm',
          { token },
          { idempotencyKey: null },
        );
        expect(response.statusCode).toBe(200);
        const header = [response.headers['set-cookie']].flat().join('\n');
        expect(header).toMatch(/httponly/i);
        expect(header).toMatch(/secure/i);
        expect(header).toMatch(/samesite=lax/i);
      });

      it('FR-AUTH-07: a state-changing call with the cookie from a foreign Origin -> 403 and nothing changes', async () => {
        const { user, session } = await world.signedIn('csrf-origin', { consent: false });
        const text = await world.currentConsent();
        const response = await session.post('/v1/me/consents', text, {
          headers: { origin: 'https://evil.example' },
        });
        expect(response.statusCode).toBe(403);
        expect(
          await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM auth.consent WHERE user_id = ${user.id}`),
        ).toBe(0);
        const me = await session.get('/v1/me');
        expect(me.json<{ consentRequired: boolean }>().consentRequired).toBe(true);
      });

      it('FR-AUTH-07: a state-changing call with the cookie and no Origin/Referer is refused', async () => {
        const { session } = await world.signedIn('csrf-no-origin', { consent: false });
        const text = await world.currentConsent();
        const response = await session.post('/v1/me/consents', text, { headers: { origin: '' } });
        expect([400, 403]).toContain(response.statusCode);
      });

      it('FR-AUTH-07: signOut from a foreign Origin does not end the session', async () => {
        const { session } = await world.signedIn('csrf-signout');
        const response = await session.post('/auth/sign-out', undefined, {
          idempotencyKey: null,
          headers: { origin: 'https://evil.example' },
        });
        expect([400, 403]).toContain(response.statusCode);
        expect((await session.get('/v1/me')).statusCode).toBe(200);
      });

      it('FR-AUTH-07: reads (GET) with a foreign Origin are not blocked as CSRF but also leak nothing cross-origin', async () => {
        const { session } = await world.signedIn('csrf-get');
        const response = await session.get('/v1/me', {
          headers: { origin: 'https://evil.example' },
        });
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      });
    });
  },
);
