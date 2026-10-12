import { hasMessage, t } from '@/i18n';
import { ApiError, NetworkError } from './errors';

/** Seconds to wait before retrying: the `Retry-After` header wins over the problem body. */
export function retryAfterOf(error: unknown): number | undefined {
  if (!(error instanceof ApiError)) return undefined;
  return error.retryAfterSeconds ?? error.problem?.retryAfterSeconds;
}

export function isRateLimited(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 429 || error.code === 'RATE_LIMITED');
}

/** User-facing Russian text for any failure; the raw server `detail` is never shown. */
export function describeError(error: unknown): string {
  if (error instanceof NetworkError) return t('errors.network');
  if (!(error instanceof ApiError)) return t('errors.unknown');
  const key = `errors.codes.${error.code ?? ''}`;
  const base = hasMessage(key) ? t(key) : t('errors.unknown');
  const wait = retryAfterOf(error);
  return isRateLimited(error) && wait !== undefined
    ? `${base} ${t('errors.retryIn', { seconds: wait })}`
    : base;
}

/** Names (first JSON-pointer segment) of the fields a 400/422 problem rejected. */
export function invalidFields(error: unknown): Set<string> {
  const names = new Set<string>();
  if (!(error instanceof ApiError)) return names;
  for (const item of error.problem?.errors ?? []) {
    const name = item.pointer.split('/').filter(Boolean)[0];
    if (name) names.add(name);
  }
  return names;
}
