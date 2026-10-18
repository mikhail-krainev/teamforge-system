import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/core';
import { throttling } from '@octokit/plugin-throttling';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { Clock } from '../../../../platform/clock/clock.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import {
  githubAppSettings,
  type GithubAppSettings,
} from '../../../../platform/config/github-app-env.js';
import { SecretBox } from '../../../../platform/crypto/secret-box.js';
import { REDIS } from '../../../../platform/redis/redis.module.js';
import { GithubError, statusOf, toGithubError } from './github-error.js';
import { InstallationTokenCache } from './installation-token-cache.js';

const DEFAULT_API = 'https://api.github.com';
const DEFAULT_OAUTH = 'https://github.com';
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = 'teamforge';
const PAGE_SIZE = 100;
/** Pages of `GET /user/installations` read to find one installation (10 x 100 installations). */
const MAX_INSTALLATION_PAGES = 10;

const NO_LOG = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
/** The Octokit class with throttling: at most 10 requests at once, `Retry-After` honoured (7.4). */
const ThrottledOctokit = Octokit.plugin(throttling);

const tokenResponse = z.object({ access_token: z.string().min(1) });

const accountSchema = z.object({ id: z.number().int(), login: z.string(), type: z.string() });
const userInstallationSchema = z.object({
  id: z.number().int(),
  account: accountSchema,
  permissions: z.record(z.string(), z.string()).default({}),
  suspended_at: z.string().nullable().default(null),
});
const userInstallationsPage = z.object({
  total_count: z.number().int(),
  installations: z.array(z.unknown()),
});

const repositorySchema = z.object({
  id: z.number().int(),
  full_name: z.string(),
  private: z.boolean(),
  fork: z.boolean(),
  created_at: z.string(),
});
const repositoriesPage = z.object({
  total_count: z.number().int(),
  repositories: z.array(z.unknown()),
});

/** An installation as `GET /user/installations` shows it to the user who authorized the App. */
export type UserInstallation = z.infer<typeof userInstallationSchema>;
/** A repository of an installation (the fields the lead chooses by). */
export type InstallationRepository = z.infer<typeof repositorySchema>;

export interface InstallationRepositoriesPage {
  items: InstallationRepository[];
  hasMore: boolean;
}

function parseOrUnavailable<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new GithubError('unavailable');
  return parsed.data;
}

/**
 * The only door to GitHub (architecture 7.5): the App JWT and the installation tokens, the OAuth step
 * of the installation and the REST calls. Tokens of installations are cached in Redis for 55 minutes,
 * sealed; user tokens are used for one request and dropped. Every failure is a `GithubError`.
 */
@Injectable()
export class GithubClient {
  private readonly settings: GithubAppSettings | null;
  private readonly apiBaseUrl: string;
  private readonly oauthBaseUrl: string;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private appAuth: ReturnType<typeof createAppAuth> | undefined;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(SecretBox) private readonly box: SecretBox,
    @Inject(Clock) private readonly clock: Clock,
  ) {
    this.settings = githubAppSettings(config);
    this.apiBaseUrl = config.GITHUB_API_BASE_URL ?? DEFAULT_API;
    this.oauthBaseUrl = config.GITHUB_OAUTH_BASE_URL ?? DEFAULT_OAUTH;
    this.clientId = config.GITHUB_APP_CLIENT_ID;
    this.clientSecret = config.GITHUB_APP_CLIENT_SECRET;
  }

  isConfigured(): boolean {
    return this.settings !== null;
  }

  /** `https://github.com/apps/<slug>/installations/new?state=...` (architecture 7.2). */
  installUrl(state: string): string {
    const settings = this.requireSettings();
    const url = new URL(`/apps/${settings.slug}/installations/new`, this.oauthBaseUrl);
    url.searchParams.set('state', state);
    return url.toString();
  }

  /**
   * Exchanges the `code` of the OAuth step for a user-to-server token. The token is returned to the
   * caller for the next request only; nobody stores it.
   */
  async exchangeUserCode(code: string): Promise<string> {
    if (this.clientId === undefined || this.clientSecret === undefined) {
      throw new GithubError('not_configured');
    }
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
    });
    let response: Response;
    try {
      response = await fetch(new URL('/login/oauth/access_token', this.oauthBaseUrl), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GithubError('unavailable');
    }
    // GitHub answers 200 with an `error` field for a wrong, used or expired code.
    if (!response.ok) throw new GithubError('unavailable', response.status);
    const parsed = tokenResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new GithubError('bad_code');
    return parsed.data.access_token;
  }

  /** The installation `installationId` among those the user can access, or `null`. */
  async findUserInstallation(
    userToken: string,
    installationId: number,
  ): Promise<UserInstallation | null> {
    const octokit = this.octokit(userToken);
    let seen = 0;
    for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
      const body = await this.call(() =>
        octokit.request('GET /user/installations', { per_page: PAGE_SIZE, page }),
      );
      const parsed = parseOrUnavailable(userInstallationsPage, body.data);
      for (const raw of parsed.installations) {
        const item = userInstallationSchema.safeParse(raw);
        if (item.success && item.data.id === installationId) return item.data;
      }
      seen += parsed.installations.length;
      if (parsed.installations.length === 0 || seen >= parsed.total_count) return null;
    }
    return null;
  }

  /** `GET /installation/repositories` with an installation token (never the App JWT). */
  async listInstallationRepositories(
    installationId: number,
    page: number,
    perPage: number,
  ): Promise<InstallationRepositoriesPage> {
    const response = await this.installationRequest(installationId, (octokit) =>
      octokit.request('GET /installation/repositories', { per_page: perPage, page }),
    );
    const parsed = parseOrUnavailable(repositoriesPage, response.data);
    const items = parsed.repositories.flatMap((raw) => {
      const repository = repositorySchema.safeParse(raw);
      return repository.success ? [repository.data] : [];
    });
    return { items, hasMore: page * perPage < parsed.total_count };
  }

  /**
   * Runs `run` with an Octokit that carries the token of the installation. A refused token (revoked,
   * or the cache outlived it) is replaced once; a token that cannot be made means the installation is
   * gone or suspended.
   */
  async installationRequest<T>(
    installationId: number,
    run: (octokit: Octokit) => Promise<T>,
  ): Promise<T> {
    const attempt = async (refresh: boolean): Promise<T> => {
      const token = await this.installationToken(installationId, refresh);
      return this.call(() => run(this.octokit(token)));
    };
    try {
      return await attempt(false);
    } catch (error) {
      if (!(error instanceof GithubError) || error.kind !== 'unauthorized') throw error;
      return attempt(true);
    }
  }

  private async installationToken(installationId: number, refresh: boolean): Promise<string> {
    try {
      const auth = await this.auth()({ type: 'installation', installationId, refresh });
      return auth.token;
    } catch (error) {
      if (error instanceof GithubError) throw error;
      const status = statusOf(error);
      if (status === 404) throw new GithubError('installation_gone', status);
      if (status === 403) throw new GithubError('installation_suspended', status);
      throw new GithubError('unavailable', status);
    }
  }

  private auth(): ReturnType<typeof createAppAuth> {
    const settings = this.requireSettings();
    const cache = new InstallationTokenCache(this.redis, this.box, this.clock);
    this.appAuth ??= createAppAuth({
      appId: settings.appId,
      privateKey: settings.privateKey,
      request: this.octokit().request,
      // auth-app types `get` as returning a string but treats a falsy result as a miss.
      cache: {
        get: (key: string) => cache.get(key) as Promise<string>,
        set: (key: string, value: string) => cache.set(key, value),
      },
    });
    return this.appAuth;
  }

  private requireSettings(): GithubAppSettings {
    if (this.settings === null) throw new GithubError('not_configured');
    return this.settings;
  }

  private octokit(token?: string): Octokit {
    return new ThrottledOctokit({
      baseUrl: this.apiBaseUrl,
      userAgent: USER_AGENT,
      log: NO_LOG,
      request: { timeout: REQUEST_TIMEOUT_MS },
      ...(token === undefined ? {} : { auth: token }),
      // An interactive request is not parked behind a limit: the caller answers 503 and retries later.
      throttle: { onRateLimit: () => false, onSecondaryRateLimit: () => false },
    });
  }

  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw toGithubError(error);
    }
  }
}
