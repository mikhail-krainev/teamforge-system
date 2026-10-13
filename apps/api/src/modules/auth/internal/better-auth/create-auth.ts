import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { magicLink } from 'better-auth/plugins/magic-link';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { uuidv7 } from 'uuidv7';
import type { AppConfig } from '../../../../platform/config/config.js';
import type { Database } from '../../../../platform/db/db.module.js';
import { normalizeEmail } from '../magic-link/email-normalizer.js';
import { account, session, user, verification } from '../schema/auth.js';
import { githubOAuthConfig } from './github-provider.js';
import { githubAccountHooks } from './github-account-hooks.js';
import { redisSessionStorage } from './redis-secondary-storage.js';

const DAY_SECONDS = 24 * 60 * 60;
/** The Better Auth route prefix; the API's global prefix `api` plus the `auth` controller. */
export const AUTH_BASE_PATH = '/api/auth';
const DEFAULT_GITHUB_OAUTH = 'https://github.com';
const DEFAULT_GITHUB_API = 'https://api.github.com';

// Linking happens only through `link-social` from a signed-in session (SEC-09): implicit linking
// by a matching e-mail is off, and the GitHub e-mail may differ from the account's.
const ACCOUNT_OPTIONS: BetterAuthOptions['account'] = {
  encryptOAuthTokens: true,
  accountLinking: {
    enabled: true,
    trustedProviders: [],
    allowDifferentEmails: true,
    disableImplicitLinking: true,
    updateUserInfoOnLink: true,
  },
};

/** What the library needs from the rest of the application (mail queue, anti-fraud signals). */
export interface AuthCallbacks {
  sendMagicLink(email: string, token: string): Promise<void>;
  recordSignIn(
    userId: string,
    ip: string | null | undefined,
    userAgent: string | null | undefined,
  ): Promise<void>;
}

export interface AuthDependencies {
  db: Database;
  redis: Redis;
  config: AppConfig;
  callbacks: AuthCallbacks;
}

/** Lifetime of a sign-in link in seconds (C-30). */
export const MAGIC_LINK_TTL_SECONDS = 15 * 60;

function githubClient(config: AppConfig): { id: string; secret: string } | undefined {
  const id = config.GITHUB_OAUTH_CLIENT_ID ?? config.GITHUB_APP_CLIENT_ID;
  const secret = config.GITHUB_OAUTH_CLIENT_SECRET ?? config.GITHUB_APP_CLIENT_SECRET;
  return id === undefined || secret === undefined ? undefined : { id, secret };
}

const hidden = { required: false, input: false } as const;
/**
 * Filled from the GitHub profile on sign-in. Better Auth copies provider-profile fields into a new
 * user only for fields with `input: true`; `input: false` ones (status, isAdmin, locale) can never
 * be set from a profile or a request body. No exposed route accepts user input.
 */
const fromProvider = { required: false, input: true } as const;

function advancedOptions(config: AppConfig): NonNullable<BetterAuthOptions['advanced']> {
  return {
    database: { generateId: () => uuidv7() },
    useSecureCookies:
      config.NODE_ENV === 'production' || config.BETTER_AUTH_URL.startsWith('https:'),
    // Better Auth skips the Origin/CSRF check when NODE_ENV=test unless it is switched on explicitly.
    disableOriginCheck: false,
    disableCSRFCheck: false,
    defaultCookieAttributes: { sameSite: 'lax', httpOnly: true },
    // The bridge sets this header from Fastify's trusted-proxy aware request.ip.
    ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
  };
}

/** Fills `email_normalized` of a new user and leaves anti-fraud signals for every new session. */
function databaseHooks(
  callbacks: AuthCallbacks,
  db: Database,
  redis: Redis,
): NonNullable<BetterAuthOptions['databaseHooks']> {
  return {
    account: githubAccountHooks(db, redis),
    user: {
      create: {
        before: (created) =>
          Promise.resolve({
            data: {
              ...created,
              emailNormalized: created.email ? normalizeEmail(created.email) : null,
            },
          }),
      },
    },
    session: {
      create: {
        // An account that waits for deletion (or is erased) gets no session at all (FR-AUTH-09).
        before: async (created) => {
          const rows = await db
            .select({ status: user.status })
            .from(user)
            .where(eq(user.id, created.userId));
          return rows[0]?.status === 'active' ? undefined : false;
        },
        after: async (created) => {
          await callbacks.recordSignIn(created.userId, created.ipAddress, created.userAgent);
        },
      },
    },
  };
}

/** GitHub sign-in through the GitHub App; no provider at all when no client is configured. */
function githubPlugin(config: AppConfig) {
  const github = githubClient(config);
  return genericOAuth({
    config:
      github === undefined
        ? []
        : [
            githubOAuthConfig({
              clientId: github.id,
              clientSecret: github.secret,
              oauthBaseUrl: config.GITHUB_OAUTH_BASE_URL ?? DEFAULT_GITHUB_OAUTH,
              apiBaseUrl: config.GITHUB_API_BASE_URL ?? DEFAULT_GITHUB_API,
            }),
          ],
  });
}

/**
 * The single Better Auth instance (ADR-0009): tables in schema `auth`, UUID v7 ids, sessions only
 * in Redis (`secondaryStorage`, nothing in `auth.session`), OAuth tokens encrypted at rest, GitHub
 * through the GitHub App, `trustedOrigins` exactly `APP_ORIGIN`.
 */
export function createAuth({ db, redis, config, callbacks }: AuthDependencies) {
  return betterAuth({
    baseURL: config.BETTER_AUTH_URL,
    basePath: AUTH_BASE_PATH,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.APP_ORIGIN],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user, session, account, verification },
    }),
    secondaryStorage: redisSessionStorage(redis),
    session: {
      expiresIn: 30 * DAY_SECONDS,
      updateAge: DAY_SECONDS,
      freshAge: 10 * 60,
      storeSessionInDatabase: false,
    },
    account: ACCOUNT_OPTIONS,
    user: {
      additionalFields: {
        githubUserId: { type: 'number', ...fromProvider },
        githubLogin: { type: 'string', ...fromProvider },
        emailNormalized: { type: 'string', ...hidden },
        status: { type: 'string', defaultValue: 'active', ...hidden },
        isAdmin: { type: 'boolean', defaultValue: false, ...hidden },
        locale: { type: 'string', defaultValue: 'ru', ...hidden },
      },
    },
    // Verification rows (magic link hashes) stay in PostgreSQL next to the Redis copy (SEC-09).
    verification: { storeInDatabase: true },
    databaseHooks: databaseHooks(callbacks, db, redis),
    advanced: advancedOptions(config),
    rateLimit: { storage: 'secondary-storage' },
    plugins: [
      githubPlugin(config),
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        storeToken: 'hashed',
        sendMagicLink: ({ email, token }) => callbacks.sendMagicLink(email, token),
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
