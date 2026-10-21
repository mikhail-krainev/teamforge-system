import { hasMessage, t } from '@/i18n';
import { describeError } from '@/lib/api/error-message';
import { ApiError } from '@/lib/api/errors';

/** More specific refusal reason a 422 REPO_REJECTED may carry in `errors[].code`. */
function rejectionReason(error: ApiError): string | undefined {
  for (const entry of error.problem?.errors ?? []) {
    const key = `github.errors.reasons.${entry.code ?? ''}`;
    if (entry.code && hasMessage(key)) return t(key);
  }
  return undefined;
}

/** Russian text of a failed install / link / unlink: repository codes first, then the common ones. */
export function githubErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    if (error.code === 'REPO_REJECTED') {
      return rejectionReason(error) ?? t('github.errors.codes.REPO_REJECTED');
    }
    const key = `github.errors.codes.${error.code}`;
    if (hasMessage(key)) return t(key);
  }
  return describeError(error);
}

export function isInstallationLost(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'INSTALLATION_NOT_GRANTED' || error.code === 'INSTALLATION_INVALID')
  );
}

export function setupErrorText(code: string | null): string {
  const key = `github.setup.errors.${code ?? ''}`;
  return hasMessage(key) ? t(key) : t('github.setup.errors.unknown');
}
