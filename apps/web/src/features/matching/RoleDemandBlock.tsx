'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { useRoles } from '@/features/profile/useProfileQueries';
import { t } from '@/i18n';
import { waitText } from './model';
import { useDemand } from './queries';

/** FR-PROF-07: one line per desired role of the profile (the server defaults to those roles). */
export function RoleDemandBlock() {
  const demand = useDemand();
  const roles = useRoles();
  return (
    <section className="card stack" aria-labelledby="role-demand-heading">
      <h2 id="role-demand-heading">{t('matching.block.title')}</h2>
      {demand.isPending ? <p role="status">{t('matching.block.loading')}</p> : null}
      {demand.isError ? (
        <Alert tone="error">
          <p>{t('matching.block.loadFailed')}</p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void demand.refetch()}
          >
            {t('matching.retry')}
          </button>
        </Alert>
      ) : null}
      {demand.data && demand.data.length === 0 ? (
        <p className="muted">{t('matching.block.empty')}</p>
      ) : null}
      {demand.data && demand.data.length > 0 ? (
        <ul>
          {demand.data.map((item) => (
            <li key={item.roleCode}>
              {t('matching.block.line', {
                role: roles.data?.find((r) => r.code === item.roleCode)?.name ?? item.roleCode,
                seats: item.openSeats,
                queued: item.queuedCandidates,
                wait: waitText(item),
              })}
            </li>
          ))}
        </ul>
      ) : null}
      <p>
        <Link href="/demand">{t('matching.block.all')}</Link>
      </p>
    </section>
  );
}
