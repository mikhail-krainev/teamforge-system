import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { githubIdentity } from '../../../../test/fakes/github-server.js';
import {
  countOf,
  expectProblem,
  expectRateLimited,
  logLinesWith,
} from '../../../../test/fixtures/assertions.js';
import { randomIp } from '../../../../test/fixtures/clients.js';
import { World } from '../../../../test/fixtures/world.js';
import { expectMatchesContract } from '../../../../test/helpers/contract.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { beginGithub, callbackOutcome, finishGithub, signInWithGithub } from './github-flow.js';

interface GithubAccount {
  linked: boolean;
  githubUserId?: number | null;
  login?: string | null;
  accountAgeOk?: boolean | null;
}

describeInfra(
  'S2 auth: sign-in with GitHub and linking (FR-AUTH-01, FR-AUTH-05)',
  ['db', 'redis'],
  () => {
    let world: World;

    beforeAll(async () => {
      world = await World.start({ github: true });
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    const uniqueIdentity = (label: string, overrides = {}) =>
      githubIdentity(`${label}-${world.runId}`, overrides);

    describe('signInSocial', () => {
      it('FR-AUTH-01: answers 200 with the GitHub authorize URL (state, client id, our callback)', async () => {
        const { response, authorizeUrl } = await beginGithub(world.browser(), 'sign-in');
        expect(response.statusCode).toBe(200);
        expectMatchesContract('signInSocial', response);
        expect(response.json<{ redirect: boolean }>().redirect).toBe(true);
        const url = new URL(authorizeUrl);
        expect(`${url.origin}${url.pathname}`).toBe(
          `${world.github?.baseUrl}/login/oauth/authorize`,
        );
        expect(url.searchParams.get('client_id')).toBe(world.github?.clientId);
        expect(url.searchParams.get('state') ?? '').not.toBe('');
        expect(url.searchParams.get('redirect_uri')).toMatch(/\/auth\/callback\/github$/);
      });

      it.each([
        ['an absolute URL', 'https://evil.example'],
        ['a protocol-relative URL', '//evil.example'],
        ['a backslash trick', '/\\evil.example'],
        ['a javascript: URL', 'javascript:alert(1)'],
      ])('FR-AUTH-01: callbackURL as %s -> 400 (SEC-08)', async (_name, callbackURL) => {
        const { response } = await beginGithub(world.browser(), 'sign-in', callbackURL);
        expect(response.statusCode).toBe(400);
        expectMatchesContract('signInSocial', response);
      });

      it.each([
        ['an unknown provider', { provider: 'gitlab' }],
        ['no provider', {}],
        ['an extra field', { provider: 'github', scopes: ['repo'] }],
      ])('FR-AUTH-01: %s -> 400', async (_name, body) => {
        const response = await world
          .browser()
          .post('/auth/sign-in/social', body, { idempotencyKey: null });
        expect(response.statusCode).toBe(400);
        expectMatchesContract('signInSocial', response);
      });

      it('FR-AUTH-01: the whole flow creates the user with github_user_id, login and the primary verified e-mail, and a session', async () => {
        const identity = uniqueIdentity('flow');
        const { session, callback } = await signInWithGithub(world, identity, '/profile');
        expect(callbackOutcome(callback)).toBe('ok');
        expect(String(callback.headers.location)).toContain('/profile');
        const rows = await world.sql<
          {
            id: string;
            github_user_id: string;
            github_login: string;
            email: string;
            status: string;
          }[]
        >`SELECT id, github_user_id::text, github_login, email, status FROM auth."user" WHERE github_user_id = ${identity.id}`;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.github_login).toBe(identity.login);
        expect(rows[0]?.email).toBe(identity.emails[0]?.email);
        expect(rows[0]?.status).toBe('active');
        const me = await session.get('/v1/me');
        expect(me.statusCode).toBe(200);
        expectMatchesContract('getMe', me);
        expect(me.json<{ github: { linked: boolean; login: string } }>().github).toMatchObject({
          linked: true,
          login: identity.login,
        });
      });

      it('FR-AUTH-01: signing in again with the same GitHub account gives the same user, not a second one', async () => {
        const identity = uniqueIdentity('again');
        await signInWithGithub(world, identity);
        await signInWithGithub(world, identity);
        expect(
          await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM auth."user" WHERE github_user_id = ${identity.id}`),
        ).toBe(1);
        expect(
          await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM auth.account WHERE provider_id = 'github' AND account_id = ${String(identity.id)}`),
        ).toBe(1);
      });

      it('FR-AUTH-01: GitHub tokens are not kept in plain text (encryptOAuthTokens, FR-GH-10)', async () => {
        const identity = uniqueIdentity('tokens');
        await signInWithGithub(world, identity);
        const accounts =
          await world.sql`SELECT * FROM auth.account WHERE account_id = ${String(identity.id)}`;
        const dump = JSON.stringify(accounts);
        for (const token of [
          ...(world.github?.issued.accessTokens ?? []),
          ...(world.github?.issued.refreshTokens ?? []),
        ]) {
          expect(dump).not.toContain(token);
        }
      });

      it('FR-AUTH-01: the OAuth code and state never appear in the application log (SEC-07)', async () => {
        const session = world.browser();
        const identity = uniqueIdentity('logs');
        const { authorizeUrl } = await beginGithub(session, 'sign-in');
        const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
        await finishGithub(world, session, authorizeUrl, identity);
        const codes = world.github?.issued.codes ?? [];
        expect(codes.length).toBeGreaterThan(0);
        expect(state).not.toBe('');
        for (const secret of [state, ...codes])
          expect(logLinesWith(world.logs, secret)).toEqual([]);
      });

      it('FR-AUTH-01: a callback with a changed state is refused: no session, no user (state is checked)', async () => {
        const session = world.browser();
        const identity = uniqueIdentity('badstate');
        const { authorizeUrl } = await beginGithub(session, 'sign-in');
        const callback = await finishGithub(world, session, authorizeUrl, identity, (url) =>
          url.searchParams.set('state', 'forged-state-value'),
        );
        expect(callbackOutcome(callback)).not.toBe('ok');
        expect((await session.get('/v1/me')).statusCode).toBe(401);
        expect(
          await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM auth."user" WHERE github_user_id = ${identity.id}`),
        ).toBe(0);
      });

      it('FR-AUTH-01: a callback in a browser that did not start the flow (no state cookie) creates nothing', async () => {
        const identity = uniqueIdentity('foreign-browser');
        const { authorizeUrl } = await beginGithub(world.browser(), 'sign-in');
        const stranger = world.browser();
        const callback = await finishGithub(world, stranger, authorizeUrl, identity);
        expect(callbackOutcome(callback)).not.toBe('ok');
        expect((await stranger.get('/v1/me')).statusCode).toBe(401);
        expect(
          await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM auth."user" WHERE github_user_id = ${identity.id}`),
        ).toBe(0);
      });

      it('FR-AUTH-01: a failed sign-in returns to /sign-in with the error and the target page kept', async () => {
        const identity = uniqueIdentity('error-page');
        const { authorizeUrl } = await beginGithub(world.browser(), 'sign-in', '/teams');
        const callback = await finishGithub(world, world.browser(), authorizeUrl, identity);
        const location = new URL(String(callback.headers.location), 'http://localhost');
        expect(location.pathname).toBe('/sign-in');
        expect(location.searchParams.get('next')).toBe('/teams');
        expect(location.searchParams.get('error')).toBe('state_mismatch');
      });

      it('FR-AUTH-01: a callback code can be used once: replaying it gives no second session or user', async () => {
        const identity = uniqueIdentity('replay');
        const session = world.browser();
        const { authorizeUrl } = await beginGithub(session, 'sign-in');
        const callbackUrl = new URL(world.github?.approve(authorizeUrl, identity) ?? '');
        const path = `${callbackUrl.pathname.replace(/^\/api/, '')}${callbackUrl.search}`;
        expect(callbackOutcome(await session.get(path))).toBe('ok');
        const second = world.browser();
        expect(callbackOutcome(await second.get(path))).not.toBe('ok');
        expect((await second.get('/v1/me')).statusCode).toBe(401);
      });

      it('FR-AUTH-01: GitHub refusing the exchange (unverified primary e-mail) ends without a user or a session', async () => {
        const identity = uniqueIdentity('unverified');
        const session = world.browser();
        const { authorizeUrl } = await beginGithub(session, 'sign-in');
        world.github?.failNextTokenExchange('unverified_user_email');
        const callback = await finishGithub(world, session, authorizeUrl, identity);
        expect(callbackOutcome(callback)).not.toBe('ok');
        expect((await session.get('/v1/me')).statusCode).toBe(401);
        expect(
          await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM auth."user" WHERE github_user_id = ${identity.id}`),
        ).toBe(0);
      });

      it('FR-AUTH-06: a GitHub identity whose e-mail equals a magic-link account is NOT merged into it (SEC-09)', async () => {
        const email = world.email('no-merge');
        await world.signIn(email);
        const victimId = await world.userIdByEmail(email);
        const identity = uniqueIdentity('no-merge-gh', {
          emails: [{ email, primary: true, verified: true, visibility: null }],
        });
        const { session } = await signInWithGithub(world, identity);
        const me = await session.get('/v1/me');
        if (me.statusCode === 200) expect(me.json<{ id: string }>().id).not.toBe(victimId);
        const victim = await world.sql<{ github_user_id: string | null }[]>`
        SELECT github_user_id::text FROM auth."user" WHERE id = ${victimId}`;
        expect(victim[0]?.github_user_id).toBeNull();
        expect(
          await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM auth.account WHERE user_id = ${victimId} AND provider_id = 'github'`),
        ).toBe(0);
      });

      it('FR-AUTH-06: signing in with GitHub records identity signals for antifraud (SEC-13)', async () => {
        const identity = uniqueIdentity('signals');
        await signInWithGithub(world, identity);
        const signals = await countOf(world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM auth.identity_signal s
          JOIN auth."user" u ON u.id = s.user_id WHERE u.github_user_id = ${identity.id}`);
        expect(signals).toBeGreaterThanOrEqual(1);
      });

      it('FR-AUTH-04: C-32 allows 10 sign-in attempts per 15 minutes per IP, the 11th -> 429 with Retry-After', async () => {
        const ip = randomIp();
        for (let i = 0; i < 10; i += 1) {
          const { response } = await beginGithub(world.browser(), 'sign-in', '/profile', ip);
          expect(response.statusCode, `attempt ${i + 1}`).toBe(200);
        }
        const { response } = await beginGithub(world.browser(), 'sign-in', '/profile', ip);
        expectRateLimited('signInSocial', response);
      });
    });

    describe('linkGithub', () => {
      it('FR-AUTH-05: without a session -> 401 UNAUTHENTICATED', async () => {
        const { response } = await beginGithub(world.browser(), 'link');
        expectProblem('linkGithub', response, 401, 'UNAUTHENTICATED');
      });

      it.each([
        ['an absolute URL', 'https://evil.example'],
        ['a protocol-relative URL', '//evil.example'],
      ])('FR-AUTH-05: callbackURL as %s -> 400 (SEC-08)', async (_name, callbackURL) => {
        const { session } = await world.signedIn('link-cb');
        const { response } = await beginGithub(session, 'link', callbackURL);
        expect(response.statusCode).toBe(400);
        expectMatchesContract('linkGithub', response);
      });

      it('FR-AUTH-05: a user who signed in by e-mail links GitHub explicitly from the session', async () => {
        const { user, session } = await world.signedIn('link-ok');
        const identity = uniqueIdentity('link-ok-gh');
        const { response, authorizeUrl } = await beginGithub(session, 'link');
        expect(response.statusCode).toBe(200);
        expectMatchesContract('linkGithub', response);
        const callback = await finishGithub(world, session, authorizeUrl, identity);
        expect(callbackOutcome(callback)).toBe('ok');
        const rows = await world.sql<{ github_user_id: string; github_login: string }[]>`
        SELECT github_user_id::text, github_login FROM auth."user" WHERE id = ${user.id}`;
        expect(rows[0]?.github_user_id).toBe(String(identity.id));
        expect(rows[0]?.github_login).toBe(identity.login);
        // the session is still the same user's, not a new one
        expect((await session.get('/v1/me')).json<{ id: string }>().id).toBe(user.id);
      });

      it('FR-AUTH-05: after linking, tokens are not kept (FR-GH-10): nothing of the issued tokens is stored', async () => {
        const { session } = await world.signedIn('link-tokens');
        const identity = uniqueIdentity('link-tokens-gh');
        const { authorizeUrl } = await beginGithub(session, 'link');
        await finishGithub(world, session, authorizeUrl, identity);
        const dump = JSON.stringify(
          await world.sql`SELECT * FROM auth.account WHERE account_id = ${String(identity.id)}`,
        );
        for (const token of world.github?.issued.accessTokens ?? [])
          expect(dump).not.toContain(token);
      });

      it('FR-AUTH-05: a GitHub account already linked to another user -> conflict GITHUB_ALREADY_LINKED, the second user stays unlinked', async () => {
        const identity = uniqueIdentity('taken');
        const first = await world.signedIn('taken-a');
        const flowA = await beginGithub(first.session, 'link');
        expect(
          callbackOutcome(await finishGithub(world, first.session, flowA.authorizeUrl, identity)),
        ).toBe('ok');

        const second = await world.signedIn('taken-b');
        const flowB = await beginGithub(second.session, 'link');
        const callback = await finishGithub(world, second.session, flowB.authorizeUrl, identity);
        expect(callbackOutcome(callback)).toBe('already-linked');
        const rows = await world.sql<{ id: string }[]>`
        SELECT id FROM auth."user" WHERE github_user_id = ${identity.id}`;
        expect(rows.map((r) => r.id)).toEqual([first.user.id]);
      });

      it('FR-AUTH-05: sign-in with a GitHub account that is linked to a user signs in THAT user', async () => {
        const identity = uniqueIdentity('linked-signin');
        const { user, session } = await world.signedIn('linked-signin-u');
        const flow = await beginGithub(session, 'link');
        await finishGithub(world, session, flow.authorizeUrl, identity);
        const { session: viaGithub } = await signInWithGithub(world, identity);
        expect((await viaGithub.get('/v1/me')).json<{ id: string }>().id).toBe(user.id);
      });
    });

    describe('getMyGithubAccount', () => {
      it('FR-AUTH-05: a user without GitHub -> 200 {linked:false}', async () => {
        const person = await world.createUser('gh-none');
        const response = await world.as(person).get('/v1/me/github');
        expect(response.statusCode).toBe(200);
        expectMatchesContract('getMyGithubAccount', response);
        expect(response.json<GithubAccount>().linked).toBe(false);
      });

      it('FR-AUTH-05: a linked user -> 200 with the numeric id and the login', async () => {
        const identity = uniqueIdentity('gh-linked');
        const person = await world.createUser('gh-linked', { github: identity });
        const response = await world.as(person).get('/v1/me/github');
        expect(response.statusCode).toBe(200);
        expectMatchesContract('getMyGithubAccount', response);
        expect(response.json<GithubAccount>()).toMatchObject({
          linked: true,
          githubUserId: identity.id,
          login: identity.login,
        });
      });

      it('FR-AUTH-05: without a session -> 401 UNAUTHENTICATED', async () => {
        expectProblem(
          'getMyGithubAccount',
          await world.anonymous().get('/v1/me/github'),
          401,
          'UNAUTHENTICATED',
        );
      });
    });
  },
);
