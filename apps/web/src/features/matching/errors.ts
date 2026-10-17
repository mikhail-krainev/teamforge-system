import { hasMessage, t } from '@/i18n';
import { ApiError } from '@/lib/api/errors';
import { actionErrorText } from '@/features/offers/errors';

/** Russian text of a failed queue / trial action: queue codes first, then the offer and team ones. */
export function matchingErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    const key = `matching.errors.codes.${error.code}`;
    if (hasMessage(key)) return t(key);
  }
  return actionErrorText(error);
}
