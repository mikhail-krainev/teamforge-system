import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { RateLimiter, type RateLimitRule } from '../../../../platform/ratelimit/rate-limiter.js';
import { REDIS } from '../../../../platform/redis/redis.module.js';

export interface ResolvedGithubLogin {
  id: number;
  /** The spelling GitHub reports (the case may differ from the input). */
  login: string;
}

/** Resolves a GitHub login to the numeric id (SEC-18): the id is what is stored and compared. */
export interface GithubLoginResolver {
  /**
   * `null` when GitHub does not know the login; throws 429 when `userId` asked GitHub too often
   * (S3SEC-02) and 503 when GitHub cannot be asked. An answer from the cache costs no GitHub call.
   */
  resolve(login: string, userId: string): Promise<ResolvedGithubLogin | null>;
}

export const GITHUB_LOGIN_RESOLVER = Symbol('GITHUB_LOGIN_RESOLVER');

const DEFAULT_API = 'https://api.github.com';
const TIMEOUT_MS = 5_000;
const HOUR_MS = 3_600_000;

/** Lookups that reach GitHub, per lead: the anonymous quota of GitHub is 60 per hour per address. */
const USER_LOOKUPS: RateLimitRule = { limit: 10, windowMs: HOUR_MS };
/** All leads together, kept under that quota; only applies to the real api.github.com. */
const GLOBAL_LOOKUPS: RateLimitRule = { limit: 45, windowMs: HOUR_MS };
// Short: a GitHub login can be renamed and taken by another account, which has another id.
const FOUND_TTL_S = 3600;
const MISSING_TTL_S = 300;
// `gh_state:` is the GitHub prefix the `api` Redis ACL user may write (docker/redis/users.acl.tpl).
const CACHE_PREFIX = 'gh_state:login:';

function unavailable(): DomainError {
  return new DomainError('INTERNAL', 503, {
    detail: 'GitHub is not reachable, try again later',
    retryAfterSeconds: 5,
    headers: { 'Retry-After': '5' },
  });
}

/**
 * `GET {api}/users/{login}` without a token (no GitHub App token is available to the `api`
 * process yet: `gh_inst_token:*` belongs to the worker); the base URL is the test double outside
 * production. The answer is cached in Redis; a miss is counted against the lead (S3SEC-02).
 */
@Injectable()
export class HttpGithubLoginResolver implements GithubLoginResolver {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  async resolve(login: string, userId: string): Promise<ResolvedGithubLogin | null> {
    const key = `${CACHE_PREFIX}${login.toLowerCase()}`;
    const cached = await this.cached(key);
    if (cached !== undefined) return cached;
    await this.limiter.enforce(
      'invitationToken',
      `github-login:${this.limiter.userSubject(userId)}`,
      USER_LOOKUPS,
    );
    if (this.config.GITHUB_API_BASE_URL === undefined) {
      await this.limiter.enforce('invitationToken', 'github-login:all', GLOBAL_LOOKUPS);
    }
    const found = await this.fetchLogin(login);
    await this.store(key, found);
    return found;
  }

  private async cached(key: string): Promise<ResolvedGithubLogin | null | undefined> {
    try {
      const text = await this.redis.get(key);
      return text === null ? undefined : (JSON.parse(text) as ResolvedGithubLogin | null);
    } catch {
      return undefined;
    }
  }

  private async store(key: string, found: ResolvedGithubLogin | null): Promise<void> {
    try {
      await this.redis.set(
        key,
        JSON.stringify(found),
        'EX',
        found === null ? MISSING_TTL_S : FOUND_TTL_S,
      );
    } catch {
      // The cache is an optimisation: a failed write must not fail the invitation.
    }
  }

  private async fetchLogin(login: string): Promise<ResolvedGithubLogin | null> {
    const base = this.config.GITHUB_API_BASE_URL ?? DEFAULT_API;
    let response: Response;
    try {
      response = await fetch(`${base}/users/${encodeURIComponent(login)}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'teamforge' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw unavailable();
    }
    if (response.status === 404) return null;
    if (!response.ok) throw unavailable();
    const body = (await response.json()) as { id?: unknown; login?: unknown; type?: unknown };
    if (typeof body.id !== 'number' || typeof body.login !== 'string') throw unavailable();
    return body.type === 'User' || body.type === undefined
      ? { id: body.id, login: body.login }
      : null;
  }
}
