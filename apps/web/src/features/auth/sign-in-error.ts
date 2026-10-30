import { t } from '@/i18n';

/** Codes Better Auth puts into `?error=` when the GitHub round trip fails before a session exists. */
const RESTART_CODES = new Set([
  'state_mismatch',
  'state_invalid',
  'state_not_found',
  'please_restart_the_process',
]);
const CANCELLED_CODES = new Set(['access_denied']);

/** The message for `/sign-in?error=<code>`, or null when there is no error to show. */
export function signInErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  if (RESTART_CODES.has(code)) return t('auth.signIn.githubRestart');
  if (CANCELLED_CODES.has(code)) return t('auth.signIn.githubCancelled');
  return t('auth.signIn.githubFailed');
}
