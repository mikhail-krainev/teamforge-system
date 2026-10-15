'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { t } from '@/i18n';
import { isGithubRequired, isVersionConflict, teamErrorText } from './errors';

interface Props {
  error: unknown;
  /** Reloads server data; offered when the version is stale (VERSION_CONFLICT). */
  onRefresh?: (() => void) | undefined;
}

/** Announces a failed team action; GITHUB_REQUIRED links to GitHub linking, VERSION_CONFLICT offers a reload. */
export function TeamErrorAlert({ error, onRefresh }: Props) {
  return (
    <Alert tone="error">
      <p>{teamErrorText(error)}</p>
      {isGithubRequired(error) ? (
        <p>
          <Link href="/settings" className="button button-secondary">
            {t('teams.errors.linkGithub')}
          </Link>
        </p>
      ) : null}
      {isVersionConflict(error) && onRefresh ? (
        <p>
          <button type="button" className="button button-secondary" onClick={onRefresh}>
            {t('teams.errors.refresh')}
          </button>
        </p>
      ) : null}
    </Alert>
  );
}
