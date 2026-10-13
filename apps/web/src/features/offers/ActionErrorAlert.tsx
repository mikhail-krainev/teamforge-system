'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { isGithubRequired, isVersionConflict } from '@/features/teams/errors';
import { t } from '@/i18n';
import { actionErrorText } from './errors';

interface Props {
  error: unknown;
  onRefresh?: (() => void) | undefined;
}

/** Announces a failed action (role="alert"); GITHUB_REQUIRED links to linking GitHub. */
export function ActionErrorAlert({ error, onRefresh }: Props) {
  return (
    <Alert tone="error">
      <p>{actionErrorText(error)}</p>
      {isGithubRequired(error) ? (
        <p>
          <Link href="/settings" className="button button-secondary">
            {t('offers.errors.linkGithub')}
          </Link>
        </p>
      ) : null}
      {isVersionConflict(error) && onRefresh ? (
        <p>
          <button type="button" className="button button-secondary" onClick={onRefresh}>
            {t('offers.errors.refresh')}
          </button>
        </p>
      ) : null}
    </Alert>
  );
}
