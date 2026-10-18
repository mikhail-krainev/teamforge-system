import { DomainError } from '../../../../platform/errors/domain-error.js';
import type { GithubError } from '../client/github-error.js';

const RETRY_AFTER_SECONDS = 5;

/** 503 for a failure of GitHub or of its settings; the detail names the kind, never GitHub's answer. */
export function githubUnavailable(error: GithubError): DomainError {
  return new DomainError('INTERNAL', 503, {
    detail:
      error.kind === 'not_configured'
        ? 'The GitHub App is not configured on this server'
        : 'GitHub is not reachable, try again later',
    retryAfterSeconds: RETRY_AFTER_SECONDS,
    headers: { 'Retry-After': String(RETRY_AFTER_SECONDS) },
  });
}
