'use client';

import { useQuery } from '@tanstack/react-query';
import { Alert } from '@/components/ui/Alert';
import { t } from '@/i18n';
import { fetchMyProfile } from './api';
import type { Profile } from './model';

interface Props {
  /** The `current` object of the 409 response; `null` when the server did not send a usable one. */
  current: Profile | null;
  busy: boolean;
  onOverwrite: (current: Profile) => void;
  onAdopt: (current: Profile) => void;
}

/** Shows the up-to-date server profile after VERSION_CONFLICT and offers to overwrite or adopt it. */
export function ConflictPanel({ current, busy, onOverwrite, onAdopt }: Props) {
  // Fallback: no usable `current` in the problem body, so ask the server for it.
  const fallback = useQuery({
    queryKey: ['profile', 'conflict-fallback'],
    queryFn: async () => (await fetchMyProfile()) ?? null,
    enabled: current === null,
    gcTime: 0,
  });
  const latest = current ?? fallback.data ?? null;
  if (!latest) {
    return (
      <p role="status" className="muted">
        {t('profile.conflict.refetching')}
      </p>
    );
  }
  return (
    <Alert tone="warn">
      <h2>{t('profile.conflict.title')}</h2>
      <p>
        {t('profile.conflict.body', {
          version: latest.version,
          updatedAt: new Date(latest.updatedAt).toLocaleString('ru-RU'),
        })}
      </p>
      <ul>
        <li>{t('profile.conflict.currentName', { name: latest.displayName })}</li>
        <li>{t('profile.conflict.currentRoles', { count: latest.rolePrefs.length })}</li>
        <li>{t('profile.conflict.currentStack', { count: latest.stack.length })}</li>
      </ul>
      <div className="row">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => onOverwrite(latest)}
        >
          {t('profile.conflict.overwrite')}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={() => onAdopt(latest)}
        >
          {t('profile.conflict.useCurrent')}
        </button>
      </div>
    </Alert>
  );
}
