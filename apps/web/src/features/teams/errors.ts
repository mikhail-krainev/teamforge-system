import { hasMessage, t } from '@/i18n';
import { ApiError } from '@/lib/api/errors';
import { describeError } from '@/lib/api/error-message';

/** Contract error codes that get a dedicated Russian message in `teams.errors.codes`. */
export function teamErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    const key = `teams.errors.codes.${error.code}`;
    if (hasMessage(key)) return t(key);
  }
  return describeError(error);
}

export function isGithubRequired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'GITHUB_REQUIRED';
}

export function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'VERSION_CONFLICT';
}
