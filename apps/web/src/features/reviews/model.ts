import { hasMessage, t } from '@/i18n';
import { ApiError } from '@/lib/api/errors';
import { describeError } from '@/lib/api/error-message';

export const MAX_REVIEW_LENGTH = 2000;

/** "2026-11-04" -> "04.11.2026": only the day of the batch is ever shown. */
export function formatDay(isoDay: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDay);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : isoDay;
}

/** The day of an ISO date-time in the same format; empty when it is not a date. */
export function formatDateTimeDay(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return '';
  const day = String(time.getDate()).padStart(2, '0');
  const month = String(time.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${time.getFullYear()}`;
}

export function validateReview(subjectUserId: string, text: string): { colleague?: string; text?: string } {
  const problems: { colleague?: string; text?: string } = {};
  if (!subjectUserId) problems.colleague = t('reviews.form.errors.colleague');
  if (text.trim().length === 0) problems.text = t('reviews.form.errors.text');
  else if (text.length > MAX_REVIEW_LENGTH) problems.text = t('reviews.form.errors.long');
  return problems;
}

/** Russian text of a failed review; an unknown code is the general error. */
export function reviewErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const key = `reviews.form.errors.codes.${error.code ?? ''}`;
    if (hasMessage(key)) return t(key);
    if (error.status === 422) return t('reviews.form.errors.self');
  }
  return describeError(error);
}
