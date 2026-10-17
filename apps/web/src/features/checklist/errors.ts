import { hasMessage, t } from '@/i18n';
import { ApiError } from '@/lib/api/errors';
import { describeError } from '@/lib/api/error-message';

/** The reason code the server may attach to a refused link (`errors[].code`), when it is known. */
function linkReasonText(error: ApiError): string | undefined {
  for (const entry of error.problem?.errors ?? []) {
    const key = `checklist.link.errors.${entry.code ?? ''}`;
    if (entry.code && hasMessage(key)) return t(key);
  }
  return undefined;
}

/** Russian text of a failed item write: a reason for a refused link, own codes, then the common ones. */
export function itemErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    if (error.code === 'LINK_REJECTED')
      return linkReasonText(error) ?? t('checklist.link.errors.rejected');
    const key = `checklist.errors.${error.code}`;
    if (hasMessage(key)) return t(key);
    if (error.status === 409 || error.status === 403 || error.status === 422) {
      return t('checklist.errors.unknown');
    }
  }
  return describeError(error);
}

export type LinkProblem = 'empty' | 'invalid' | 'notHttps';

/** Cheap client check of a link; the server still decides (https only, no internal addresses). */
export function checkLink(raw: string): 'ok' | LinkProblem {
  const value = raw.trim();
  if (value === '') return 'empty';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'invalid';
  }
  return url.protocol === 'https:' ? 'ok' : 'notHttps';
}
