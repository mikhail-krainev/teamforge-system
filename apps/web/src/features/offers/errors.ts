import { hasMessage, t } from '@/i18n';
import { ApiError } from '@/lib/api/errors';
import { teamErrorText } from '@/features/teams/errors';

const NAMESPACES = ['offers', 'invitations', 'votes'] as const;

/** Russian text of a failed offer / invitation / leave action: own codes first, then the team codes. */
export function actionErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    for (const ns of NAMESPACES) {
      const key = `${ns}.errors.codes.${error.code}`;
      if (hasMessage(key)) return t(key);
    }
  }
  return teamErrorText(error);
}
