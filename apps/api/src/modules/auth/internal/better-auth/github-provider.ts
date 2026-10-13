import type { GenericOAuthConfig } from 'better-auth/plugins/generic-oauth';
import type { OAuth2Tokens } from 'better-auth/oauth2';

export interface GithubProviderOptions {
  clientId: string;
  clientSecret: string;
  /** `https://github.com` unless a test double is configured. */
  oauthBaseUrl: string;
  /** `https://api.github.com` unless a test double is configured. */
  apiBaseUrl: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
}

interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url?: string;
}

interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

const JSON_HEADERS = { Accept: 'application/json', 'User-Agent': 'teamforge' } as const;

function expiresAt(seconds: number | undefined): Date | undefined {
  return seconds === undefined ? undefined : new Date(Date.now() + seconds * 1000);
}

async function exchangeCode(
  options: GithubProviderOptions,
  data: { code: string; redirectURI: string; codeVerifier?: string | undefined },
): Promise<OAuth2Tokens> {
  const body = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    code: data.code,
    redirect_uri: data.redirectURI,
  });
  if (data.codeVerifier !== undefined) body.set('code_verifier', data.codeVerifier);
  const response = await fetch(`${options.oauthBaseUrl}/login/oauth/access_token`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const parsed = (await response.json()) as TokenResponse;
  // GitHub answers 200 with an `error` field for a bad or reused code.
  if (!response.ok || parsed.error !== undefined || parsed.access_token === undefined) {
    throw new Error(`GitHub token exchange failed: ${parsed.error ?? response.status}`);
  }
  return {
    tokenType: parsed.token_type,
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    accessTokenExpiresAt: expiresAt(parsed.expires_in),
    refreshTokenExpiresAt: expiresAt(parsed.refresh_token_expires_in),
    scopes: parsed.scope ? parsed.scope.split(',') : [],
  };
}

async function getJson<T>(url: string, accessToken: string): Promise<T | null> {
  const response = await fetch(url, {
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${accessToken}` },
  });
  return response.ok ? ((await response.json()) as T) : null;
}

async function fetchProfile(options: GithubProviderOptions, tokens: OAuth2Tokens) {
  const accessToken = tokens.accessToken;
  if (accessToken === undefined) return null;
  const user = await getJson<GithubUser>(`${options.apiBaseUrl}/user`, accessToken);
  if (user === null) return null;
  const emails =
    (await getJson<GithubEmail[]>(`${options.apiBaseUrl}/user/emails`, accessToken)) ?? [];
  // Only a verified address counts (FR-AUTH-06); the primary one is preferred.
  const verified = emails.filter((entry) => entry.verified);
  const chosen = verified.find((entry) => entry.primary) ?? verified[0];
  return {
    id: String(user.id),
    name: user.name ?? user.login,
    email: chosen?.email,
    emailVerified: chosen !== undefined,
    image: user.avatar_url,
    githubUserId: user.id,
    githubLogin: user.login,
  };
}

/**
 * Sign-in with the GitHub App (user-to-server OAuth, architecture 7.1) registered as a generic
 * OAuth provider with id `github`: Better Auth then serves it through `sign-in/social`,
 * `link-social` and `callback/github`. Own endpoints (instead of the built-in `github` provider)
 * because the built-in one cannot be pointed at a test double. `scope` is ignored by GitHub Apps.
 */
export function githubOAuthConfig(options: GithubProviderOptions): GenericOAuthConfig {
  return {
    providerId: 'github',
    name: 'GitHub',
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    authorizationUrl: `${options.oauthBaseUrl}/login/oauth/authorize`,
    tokenUrl: `${options.oauthBaseUrl}/login/oauth/access_token`,
    scopes: [],
    getToken: (data) => exchangeCode(options, data),
    getUserInfo: (tokens) => fetchProfile(options, tokens),
    mapProfileToUser: (profile) => ({
      githubUserId: profile.githubUserId as number,
      githubLogin: profile.githubLogin as string,
    }),
  };
}
