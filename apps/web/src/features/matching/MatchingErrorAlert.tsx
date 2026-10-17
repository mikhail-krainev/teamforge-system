'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { isGithubRequired } from '@/features/teams/errors';
import { t } from '@/i18n';
import { matchingErrorText } from './errors';

/** Announces a failed queue / trial action (role="alert"); GITHUB_REQUIRED links to linking GitHub. */
export function MatchingErrorAlert({ error }: { error: unknown }) {
  return (
    <Alert tone="error">
      <p>{matchingErrorText(error)}</p>
      {isGithubRequired(error) ? (
        <p>
          <Link href="/settings" className="button button-secondary">
            {t('matching.errors.linkGithub')}
          </Link>
        </p>
      ) : null}
    </Alert>
  );
}
