'use client';

import { useQuery } from '@tanstack/react-query';
import { Alert } from '@/components/ui/Alert';
import type { CatalogEntry } from '@/features/profile/api';
import { t } from '@/i18n';
import { ApiError } from '@/lib/api/errors';
import { fetchMyApplication, type SearchApplication } from './api';
import { orderedRoleCodes } from './model';

function isApplication(value: unknown): value is SearchApplication {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.version === 'number' && Array.isArray(v.roles) && typeof v.id === 'string';
}

/** The application carried by a 409 VERSION_CONFLICT (`problem.current`), or `null` (refetch then). */
export function applicationFromConflict(error: unknown): SearchApplication | null {
  if (!(error instanceof ApiError)) return null;
  const current = error.problem?.current;
  return isApplication(current) ? current : null;
}

interface Props {
  current: SearchApplication | null;
  roles: readonly CatalogEntry[];
  busy: boolean;
  onOverwrite: (current: SearchApplication) => void;
  onAdopt: (current: SearchApplication) => void;
}

/** After VERSION_CONFLICT: shows the stored application and lets the user keep their roles or take it. */
export function ApplicationConflict({ current, roles, busy, onOverwrite, onAdopt }: Props) {
  const fallback = useQuery({
    queryKey: ['applications', 'conflict-fallback'],
    queryFn: () => fetchMyApplication(),
    enabled: current === null,
    gcTime: 0,
  });
  const latest = current ?? fallback.data ?? null;
  if (!latest) {
    return (
      <p role="status" className="muted">
        {t('matching.conflict.refetching')}
      </p>
    );
  }
  const names = orderedRoleCodes(latest)
    .map((code) => roles.find((r) => r.code === code)?.name ?? code)
    .join(', ');
  return (
    <Alert tone="warn">
      <h2>{t('matching.conflict.title')}</h2>
      <p>{t('matching.conflict.body', { version: latest.version, roles: names })}</p>
      <div className="row">
        <button type="button" className="button" disabled={busy} onClick={() => onOverwrite(latest)}>
          {t('matching.conflict.overwrite')}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={() => onAdopt(latest)}
        >
          {t('matching.conflict.useCurrent')}
        </button>
      </div>
    </Alert>
  );
}
