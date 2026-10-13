import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';

export interface ResolvedGithubLogin {
  id: number;
  /** The spelling GitHub reports (the case may differ from the input). */
  login: string;
}

/** Resolves a GitHub login to the numeric id (SEC-18): the id is what is stored and compared. */
export interface GithubLoginResolver {
  /** `null` when GitHub does not know the login; throws 503 when GitHub cannot be asked. */
  resolve(login: string): Promise<ResolvedGithubLogin | null>;
}

export const GITHUB_LOGIN_RESOLVER = Symbol('GITHUB_LOGIN_RESOLVER');

const DEFAULT_API = 'https://api.github.com';
const TIMEOUT_MS = 5_000;

function unavailable(): DomainError {
  return new DomainError('INTERNAL', 503, {
    detail: 'GitHub is not reachable, try again later',
    retryAfterSeconds: 5,
    headers: { 'Retry-After': '5' },
  });
}

/** `GET {api}/users/{login}` without a token; the base URL is the test double outside production. */
@Injectable()
export class HttpGithubLoginResolver implements GithubLoginResolver {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async resolve(login: string): Promise<ResolvedGithubLogin | null> {
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
