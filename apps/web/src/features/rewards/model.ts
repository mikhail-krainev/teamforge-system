import { hasMessage, t } from '@/i18n';
import { ApiError } from '@/lib/api/errors';
import { describeError } from '@/lib/api/error-message';
import type { Award, Badge, CreditRow } from './api';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MIN_DISPUTE_LENGTH = 20;
export const MAX_DISPUTE_LENGTH = 4000;

/** "Backend-разработчик" -> "Backend": a Latin head before a hyphen is the compact label. */
export function shortRoleName(name: string): string {
  const match = /^([A-Za-z][A-Za-z0-9.+#]*)-/.exec(name);
  return match?.[1] ?? name;
}

/** "6 д 23 ч 59 мин"; `null` once the moment has passed. */
export function formatCountdown(untilIso: string, now: Date): string | null {
  const left = Date.parse(untilIso) - now.getTime();
  if (Number.isNaN(left) || left <= 0) return null;
  const minutes = Math.ceil(left / MINUTE_MS);
  const days = Math.floor((minutes * MINUTE_MS) / DAY_MS);
  const hours = Math.floor(((minutes * MINUTE_MS) % DAY_MS) / HOUR_MS);
  return t('rewards.credit.countdown.value', { days, hours, minutes: minutes % 60 });
}

export function isCoolingOpen(untilIso: string, now: Date): boolean {
  return Date.parse(untilIso) > now.getTime();
}

/** Why a credit row is not "credited": a known code gets its text, anything else the status default. */
export function creditReason(row: CreditRow): string | null {
  if (row.status === 'credited') return null;
  const known = row.reason ? `rewards.credit.reasons.${row.reason}` : '';
  if (known && hasMessage(known)) return t(known);
  return t(`rewards.credit.reasonDefault.${row.status}`);
}

export function stepLabel(item: Pick<Award | Badge, 'step'>): string | null {
  return item.step == null ? null : t('rewards.awards.step', { step: item.step });
}

export function validateDispute(text: string): string | null {
  const length = text.trim().length;
  if (length < MIN_DISPUTE_LENGTH) return t('rewards.dispute.errors.short');
  if (length > MAX_DISPUTE_LENGTH) return t('rewards.dispute.errors.long');
  return null;
}

/** Russian text of a failed complaint; an unknown code is the general error. */
export function disputeErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    const key = `rewards.dispute.errors.codes.${error.code}`;
    if (hasMessage(key)) return t(key);
  }
  if (error instanceof ApiError && error.status === 409) return t('rewards.dispute.errors.conflict');
  return describeError(error);
}
