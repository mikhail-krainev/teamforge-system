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
  | 'rate_limited'
  | 'unavailable';

export class GithubError extends Error {
  constructor(
    readonly kind: GithubErrorKind,
    readonly status?: number,
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
  if (status === 429 || status === 403) return new GithubError('rate_limited', status);
  return new GithubError('unavailable', status);
}
