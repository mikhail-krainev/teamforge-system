import type { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../../test/helpers/app.js';
import {
  createTestDatabase,
  describeInfra,
  scanKeys,
  type TestDatabase,
} from '../../../../test/helpers/infra.js';
import { REDIS } from '../../../platform/redis/redis.module.js';
import { SessionRevoker } from '../internal/services/session-revoker.js';
import { type DoubleIdentity, type GithubDouble, startGithubDouble } from './github-double.js';

const ORIGIN = 'http://127.0.0.1:3000';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A browser without a browser: keeps the cookies a response sets and sends them back. */
class Jar {
  private readonly cookies = new Map<string, string>();
  /** Set-Cookie lines received so far (attributes included). */
  readonly lines: string[] = [];

  absorb(setCookie: string | string[] | undefined): void {
    for (const line of [setCookie ?? []].flat()) {
      this.lines.push(line);
      const [pair = ''] = line.split(';');
      const at = pair.indexOf('=');
      const [name, value] = [pair.slice(0, at), pair.slice(at + 1)];
      if (value === '' || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

const person = (id: number, login: string): DoubleIdentity => ({
  id,
  login,
  email: `${login}@example.test`,
});

describeInfra('S2-01 Better Auth prototype in NestJS 12 + Fastify', ['db', 'redis'], () => {
  let db: TestDatabase;
  let testApp: TestApp;
  let github: GithubDouble;
  let redis: Redis;

  beforeAll(async () => {
    github = await startGithubDouble();
    db = await createTestDatabase();
    testApp = await createTestApp({
      databaseUrl: db.url,
      testSupport: false,
      env: {
        GITHUB_APP_CLIENT_ID: github.clientId,
        GITHUB_APP_CLIENT_SECRET: github.clientSecret,
        GITHUB_OAUTH_BASE_URL: github.baseUrl,
        GITHUB_API_BASE_URL: github.baseUrl,
      },
    });
    redis = testApp.app.get<Redis>(REDIS);
  });

  afterAll(async () => {
    await testApp.close();
    await db.drop();
    await github.close();
  });

  const request = (
    method: 'GET' | 'POST',
    url: string,
    jar: Jar,
    options: { payload?: object; origin?: string | null } = {},
  ) =>
    testApp.app.inject({
      method,
      url,
      headers: {
        ...(jar.header() === '' ? {} : { cookie: jar.header() }),
        ...(options.origin === null ? {} : { origin: options.origin ?? ORIGIN }),
      },
      ...(options.payload ? { payload: options.payload } : {}),
    });

  const getSession = (jar: Jar) => request('GET', '/api/auth/get-session', jar, { origin: null });

  /** sign-in/social -> GitHub authorize (double) -> callback; returns the signed-in jar. */
  async function signInWithGithub(identity: DoubleIdentity): Promise<Jar> {
    const jar = new Jar();
    const start = await request('POST', '/api/auth/sign-in/social', jar, {
      payload: { provider: 'github', callbackURL: '/profile' },
    });
    expect(start.statusCode).toBe(200);
    jar.absorb(start.headers['set-cookie']);
    const { url } = start.json<{ url: string }>();
    expect(url.startsWith(`${github.baseUrl}/login/oauth/authorize`)).toBe(true);
    const callback = new URL(github.approve(url, identity));
    const done = await request('GET', `${callback.pathname}${callback.search}`, jar, {
      origin: null,
    });
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe('/profile');
    jar.absorb(done.headers['set-cookie']);
    return jar;
  }

  it('signs in through the GitHub App flow, sets the session cookie and returns the session', async () => {
    const jar = await signInWithGithub(person(4242, 'spike-user'));
    expect(jar.header()).toMatch(/better-auth\.session_token=/);
    const session = await getSession(jar);
    expect(session.statusCode).toBe(200);
    const body = session.json<{
      user: { id: string; githubLogin: string; githubUserId: number };
    }>();
    expect(body.user.id).toMatch(UUID_V7);
    expect(body.user.githubLogin).toBe('spike-user');
    expect(body.user.githubUserId).toBe(4242);
  });

  it('sets the session cookie HttpOnly, SameSite=Lax and without Domain', async () => {
    const jar = await signInWithGithub(person(4141, 'cookie'));
    const line = jar.lines.find((entry) => entry.startsWith('better-auth.session_token=')) ?? '';
    expect(line).toMatch(/httponly/i);
    expect(line).toMatch(/samesite=lax/i);
    expect(line).toMatch(/path=[/]/i);
    expect(line).not.toMatch(/domain=/i);
  });

  it('keeps sessions in Redis only and the OAuth tokens encrypted in the database', async () => {
    await signInWithGithub(person(4343, 'spike-two'));
    expect(await db.sql`SELECT 1 FROM auth.session`).toHaveLength(0);
    expect((await scanKeys(redis, 'better-auth:*')).length).toBeGreaterThan(0);
    const accounts = await db.sql`SELECT id, access_token, refresh_token FROM auth.account`;
    expect(accounts.length).toBeGreaterThan(0);
    for (const row of accounts) {
      expect(String(row.id)).toMatch(UUID_V7);
      expect(github.accessTokens).not.toContain(row.access_token);
      expect(String(row.access_token)).not.toMatch(/^ghu_/);
      expect(String(row.refresh_token)).not.toMatch(/^ghr_/);
    }
  });

  it('login -> cookie -> getSession -> signOut -> the session is invalid', async () => {
    const jar = await signInWithGithub(person(4444, 'out'));
    expect((await getSession(jar)).json()).not.toBeNull();
    const out = await request('POST', '/api/auth/sign-out', jar);
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ success: true });
    const stale = jar.header();
    jar.absorb(out.headers['set-cookie']);
    expect(jar.header()).not.toMatch(/session_token/);
    const replay = await testApp.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie: stale },
    });
    expect(replay.json()).toBeNull();
    expect((await request('POST', '/api/auth/sign-out', new Jar())).statusCode).toBe(401);
  });

  it('rejects a state-changing call from a foreign Origin and keeps the session', async () => {
    const jar = await signInWithGithub(person(4545, 'csrf'));
    const response = await request('POST', '/api/auth/sign-out', jar, {
      origin: 'https://evil.example',
    });
    expect(response.statusCode).toBe(403);
    expect((await getSession(jar)).json()).not.toBeNull();
  });

  it('rejects a state-changing call with the cookie and without Origin/Referer (SEC-24)', async () => {
    const jar = await signInWithGithub(person(4848, 'no-origin'));
    const response = await request('POST', '/api/auth/sign-out', jar, { origin: null });
    expect(response.statusCode).toBe(403);
    expect((await getSession(jar)).json()).not.toBeNull();
  });

  it('revokeUserSessions removes every session of the user from Redis', async () => {
    const mine = person(4646, 'revoked');
    const jars = [
      await signInWithGithub(mine),
      await signInWithGithub(mine),
      await signInWithGithub(mine),
    ];
    const bystander = await signInWithGithub(person(4747, 'bystander'));
    const first = jars[0] as Jar;
    const userId = (await getSession(first)).json<{ user: { id: string } }>().user.id;
    expect(await redis.exists(`better-auth:active-sessions-${userId}`)).toBe(1);
    await testApp.app.get(SessionRevoker).revokeUserSessions(userId);
    for (const jar of jars) expect((await getSession(jar)).json()).toBeNull();
    expect(await redis.exists(`better-auth:active-sessions-${userId}`)).toBe(0);
    const values = await Promise.all(
      (await scanKeys(redis, 'better-auth:*')).map((key) => redis.get(key)),
    );
    expect(values.filter((value) => value?.includes(userId))).toHaveLength(0);
    expect((await getSession(bystander)).json()).not.toBeNull();
  });

  it('exposes only the routes of the contract: a library route outside it is 404', async () => {
    const response = await request('GET', '/api/auth/list-sessions', new Jar(), { origin: null });
    expect(response.statusCode).toBe(404);
  });

  it('validates the body against the contract before Better Auth sees it', async () => {
    const response = await request('POST', '/api/auth/sign-in/social', new Jar(), {
      payload: { provider: 'google' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects an absolute callbackURL (SEC-08)', async () => {
    const response = await request('POST', '/api/auth/sign-in/social', new Jar(), {
      payload: { provider: 'github', callbackURL: 'https://evil.example/' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('does not set the session cookie on a forged state', async () => {
    const response = await request(
      'GET',
      '/api/auth/callback/github?code=x&state=forged',
      new Jar(),
      { origin: null },
    );
    expect(response.statusCode).toBe(302);
    expect(String(response.headers.location)).toContain('error=');
    expect(JSON.stringify(response.headers['set-cookie'] ?? '')).not.toMatch(/session_token=[^;]/);
  });
});
