import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubOAuthConfig } from './github-provider.js';

const options = {
  clientId: 'cid',
  clientSecret: 'secret',
  oauthBaseUrl: 'https://gh.test',
  apiBaseUrl: 'https://api.gh.test',
};

type Route = (url: string, init?: RequestInit) => { status?: number; body: unknown };

/** Replaces `fetch` with a router; returns the requests it saw. */
function stubFetch(route: Route): { url: string; init?: RequestInit }[] {
  const seen: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    seen.push({ url, ...(init ? { init } : {}) });
    const { status = 200, body } = route(url, init);
    return new Response(JSON.stringify(body), { status });
  });
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('githubOAuthConfig', () => {
  it('points Better Auth at the configured GitHub endpoints', () => {
    const config = githubOAuthConfig(options);
    expect(config).toMatchObject({
      providerId: 'github',
      authorizationUrl: 'https://gh.test/login/oauth/authorize',
      tokenUrl: 'https://gh.test/login/oauth/access_token',
      scopes: [],
    });
  });

  it('exchanges a code, sending the PKCE verifier when there is one', async () => {
    const seen = stubFetch(() => ({
      body: {
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 60,
        refresh_token_expires_in: 120,
        token_type: 'bearer',
        scope: 'a,b',
      },
    }));
    const tokens = await githubOAuthConfig(options).getToken?.({
      code: 'c1',
      redirectURI: 'https://app.test/cb',
      codeVerifier: 'ver',
    });
    expect(tokens).toMatchObject({
      accessToken: 'at',
      refreshToken: 'rt',
      tokenType: 'bearer',
      scopes: ['a', 'b'],
    });
    expect(tokens?.accessTokenExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(tokens?.refreshTokenExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 60_000);
    const sent = new URLSearchParams(String(seen[0]?.init?.body));
    expect(sent.get('code_verifier')).toBe('ver');
    expect(sent.get('code')).toBe('c1');
  });

  it('works without a verifier, refresh token or scope', async () => {
    const seen = stubFetch(() => ({ body: { access_token: 'at' } }));
    const tokens = await githubOAuthConfig(options).getToken?.({
      code: 'c1',
      redirectURI: 'https://app.test/cb',
    });
    expect(tokens?.scopes).toEqual([]);
    expect(tokens?.accessTokenExpiresAt).toBeUndefined();
    expect(new URLSearchParams(String(seen[0]?.init?.body)).has('code_verifier')).toBe(false);
  });

  it('rejects a bad code that GitHub answers with 200 and an error field', async () => {
    stubFetch(() => ({ body: { error: 'bad_verification_code' } }));
    await expect(
      githubOAuthConfig(options).getToken?.({ code: 'x', redirectURI: 'https://app.test/cb' }),
    ).rejects.toThrow('bad_verification_code');
  });

  it('rejects a failed HTTP answer and an answer without an access token', async () => {
    stubFetch(() => ({ status: 500, body: {} }));
    await expect(
      githubOAuthConfig(options).getToken?.({ code: 'x', redirectURI: 'r' }),
    ).rejects.toThrow('500');
    stubFetch(() => ({ body: {} }));
    await expect(
      githubOAuthConfig(options).getToken?.({ code: 'x', redirectURI: 'r' }),
    ).rejects.toThrow('GitHub token exchange failed');
  });

  describe('getUserInfo', () => {
    const user = { id: 42, login: 'octo', name: null, email: null, avatar_url: 'https://a.test/i' };

    it('prefers the primary verified address and ignores unverified ones', async () => {
      stubFetch((url) => ({
        body: url.endsWith('/user')
          ? user
          : [
              { email: 'unverified@x.test', primary: true, verified: false },
              { email: 'other@x.test', primary: false, verified: true },
              { email: 'main@x.test', primary: true, verified: true },
            ],
      }));
      const profile = await githubOAuthConfig(options).getUserInfo?.({ accessToken: 'at' });
      expect(profile).toMatchObject({
        id: '42',
        name: 'octo',
        email: 'main@x.test',
        emailVerified: true,
        githubUserId: 42,
        githubLogin: 'octo',
      });
    });

    it('falls back to the first verified address when none is primary', async () => {
      stubFetch((url) => ({
        body: url.endsWith('/user')
          ? { ...user, name: 'Octo Cat' }
          : [{ email: 'second@x.test', primary: false, verified: true }],
      }));
      const profile = await githubOAuthConfig(options).getUserInfo?.({ accessToken: 'at' });
      expect(profile).toMatchObject({ name: 'Octo Cat', email: 'second@x.test' });
    });

    it('reports no verified e-mail when GitHub lists none or refuses the e-mail scope', async () => {
      stubFetch((url) =>
        url.endsWith('/user') ? { body: user } : { status: 404, body: { message: 'Not Found' } },
      );
      const profile = await githubOAuthConfig(options).getUserInfo?.({ accessToken: 'at' });
      expect(profile).toMatchObject({ email: undefined, emailVerified: false });
    });

    it('returns null without an access token or when the user request fails', async () => {
      const seen = stubFetch(() => ({ status: 401, body: {} }));
      expect(await githubOAuthConfig(options).getUserInfo?.({})).toBeNull();
      expect(seen).toHaveLength(0);
      expect(await githubOAuthConfig(options).getUserInfo?.({ accessToken: 'bad' })).toBeNull();
    });
  });

  it('maps the profile to the GitHub columns of the user', () => {
    const mapped = githubOAuthConfig(options).mapProfileToUser?.({
      emailVerified: true,
      githubUserId: 7,
      githubLogin: 'seven',
    });
    expect(mapped).toEqual({ githubUserId: 7, githubLogin: 'seven' });
  });
});
