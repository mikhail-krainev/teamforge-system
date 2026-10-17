import { hasMessage, t } from '@/i18n';
import { ApiError } from '@/lib/api/errors';
import { describeError } from '@/lib/api/error-message';

/** Russian text of a failed upload / delete: the artifact codes first, then the common ones. */
export function artifactErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    const key = `artifacts.errors.${error.code}`;
    if (hasMessage(key)) return t(key);
    if (error.status === 413) return t('artifacts.errors.FILE_TOO_LARGE');
    if (error.status === 415) return t('artifacts.errors.FILE_TYPE_REJECTED');
  }
  return describeError(error);
}
