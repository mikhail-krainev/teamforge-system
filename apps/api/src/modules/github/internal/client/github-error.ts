/**
 * Why a call to GitHub failed, in terms the callers act on. The message never carries a URL, a header
 * or a body of GitHub: those can hold tokens (architecture 13.4).
 */
export type GithubErrorKind =
  /** The GitHub App settings are absent (development without GitHub). */
  | 'not_configured'
  /** The installation is gone on GitHub: no token can be made for it. */
  | 'installation_gone'
  /** The installation is suspended by its owner or by GitHub. */
  | 'installation_suspended'
  /** The `code` of the OAuth step is wrong, used or expired. */
  | 'bad_code'
  /** The user token was refused. */
  | 'unauthorized'
  | 'not_found'
  /** A primary or secondary limit: `retryAfterMs` / `resetAt` say when to come back. */
  | 'rate_limited'
  /** 403 that is no limit: the installation lacks the permission for this call. */
  | 'forbidden'
  | 'unavailable';

export class GithubError extends Error {
  constructor(
    readonly kind: GithubErrorKind,
    readonly status?: number,
    /** `Retry-After` of a limit, as milliseconds from the moment of the answer. */
    readonly retryAfterMs?: number,
    /** `X-RateLimit-Reset` of an exhausted quota (an absolute time by the clock of GitHub). */
    readonly resetAt?: Date,
  ) {
    super(`GitHub call failed: ${kind}${status === undefined ? '' : ` (HTTP ${status})`}`);
    this.name = 'GithubError';
  }
}

/** `RequestError` of Octokit carries the HTTP status; anything else is a network failure. */
export function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Maps an Octokit failure of an ordinary call (not the token step) to a `GithubError`. */
export function toGithubError(error: unknown): GithubError {
  if (error instanceof GithubError) return error;
  const status = statusOf(error);
  if (status === 401) return new GithubError('unauthorized', status);
  if (status === 404) return new GithubError('not_found', status);
  if (status === 429 || status === 403) return limitOrForbidden(error, status);
  return new GithubError('unavailable', status);
}

function headerOf(error: unknown, name: string): string | undefined {
  const headers = (error as { response?: { headers?: Record<string, unknown> } } | null)?.response
    ?.headers;
  const value = headers?.[name];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

/**
 * 429 is always a limit. 403 is one when GitHub says when to come back (`Retry-After`, or an empty
 * quota with its reset time); any other 403 is a missing permission, which is not worth retrying.
 */
function limitOrForbidden(error: unknown, status: number): GithubError {
  const retryAfter = Number(headerOf(error, 'retry-after'));
  const retryAfterMs =
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
  const exhausted = headerOf(error, 'x-ratelimit-remaining') === '0';
  const reset = Number(headerOf(error, 'x-ratelimit-reset'));
  const resetAt =
    exhausted && Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined;
  if (status === 429 || retryAfterMs !== undefined || exhausted) {
    return new GithubError('rate_limited', status, retryAfterMs, resetAt);
  }
  return new GithubError('forbidden', status);
}
