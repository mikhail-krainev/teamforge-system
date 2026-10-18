import { hasMessage, t } from '@/i18n';
import { ApiError } from '@/lib/api/errors';
import type { CompletionCheck, CompletionCheckResult } from './api';

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const RELEASE_KEY = /^release_alive/;
const LINK_KEY = /link/;
/** `data` fields that may carry the moment the next release check becomes possible. */
const RETRY_FIELDS = ['retryAt', 'repeatAt', 'nextCheckAt', 'nextAt', 'earliestAt', 'availableAt'];
const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;

export function isReleaseResult(result: Pick<CompletionCheckResult, 'key'>): boolean {
  return RELEASE_KEY.test(result.key);
}

export function checkTitle(key: string): string {
  const known = `completion.checks.items.${key}.title`;
  if (hasMessage(known)) return t(known);
  return LINK_KEY.test(key)
    ? t('completion.checks.items.links.title')
    : t('completion.checks.otherTitle');
}

export function checkHint(key: string): string | null {
  const known = `completion.checks.items.${key}.hint`;
  if (hasMessage(known)) return t(known);
  return LINK_KEY.test(key) ? t('completion.checks.items.links.hint') : null;
}

function dataOf(result: CompletionCheckResult): Record<string, unknown> {
  return typeof result.data === 'object' && result.data !== null ? result.data : {};
}

/** Why a check failed, from the reason code of the worker (never the server's free text). */
export function reasonText(result: CompletionCheckResult): string | null {
  const reason = dataOf(result).reason;
  if (typeof reason !== 'string') return null;
  const key = `completion.checks.reasons.${reason}`;
  return hasMessage(key) ? t(key) : null;
}

export function httpStatusOf(result: CompletionCheckResult): number | null {
  const status = dataOf(result).httpStatus;
  return typeof status === 'number' && status >= HTTP_STATUS_MIN && status <= HTTP_STATUS_MAX
    ? status
    : null;
}

/** The moment the second release check becomes possible, if the result says so. */
export function retryAtOf(result: CompletionCheckResult): Date | null {
  const data = dataOf(result);
  for (const field of RETRY_FIELDS) {
    const value = data[field];
    if (typeof value !== 'string') continue;
    const time = Date.parse(value);
    if (!Number.isNaN(time)) return new Date(time);
  }
  return null;
}

/** "23 ч 59 мин" / "45 мин"; at least one minute while any time is left. */
export function formatRemaining(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE_MS));
  const hours = Math.floor(minutes / HOUR_MINUTES);
  return hours > 0
    ? t('completion.checks.secondCheck.hours', { hours, minutes: minutes % HOUR_MINUTES })
    : t('completion.checks.secondCheck.minutes', { minutes });
}

export function isCheckFresh(check: CompletionCheck, now: Date): boolean {
  return check.validUntil != null && Date.parse(check.validUntil) > now.getTime();
}

/** The check is finished, still valid and has no blocking failure: the server will accept "Завершить". */
export function isCheckGreen(check: CompletionCheck | null | undefined, now: Date): boolean {
  if (!check || check.status !== 'done' || !isCheckFresh(check, now)) return false;
  return check.results.every((result) => result.ok || !result.blocking);
}

export function unmetFromError(
  error: unknown,
): { code: string; message?: string | undefined }[] | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status !== 409 || error.code !== 'COMPLETION_BLOCKED') return null;
  return (error.problem?.unmet ?? []).map((entry) => ({
    code: entry.code,
    message: entry.message,
  }));
}

export function unmetText(entry: { code: string; message?: string | undefined }): string {
  const key = `completion.unmet.${entry.code}`;
  if (hasMessage(key)) return t(key);
  return entry.message ?? t('completion.unmet.unknown');
}

export function finishErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    const key = `completion.finish.errors.${error.code}`;
    if (hasMessage(key)) return t(key);
  }
  return t('completion.finish.errors.unknown');
}
