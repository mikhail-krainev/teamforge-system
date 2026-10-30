'use client';

import Link from 'next/link';
import { Yeti } from '@/components/mascot/Yeti';
import { Alert } from '@/components/ui/Alert';
import type { CatalogEntry } from '@/features/profile/api';
import { useRoles } from '@/features/profile/useProfileQueries';
import { t } from '@/i18n';
import type { RoleDemand } from './api';
import './matching.css';
import { waitText } from './model';
import { useDemand } from './queries';

const MAX_ROLES = 20;

function DemandTable({
  items,
  roles,
}: {
  items: readonly RoleDemand[];
  roles: readonly CatalogEntry[];
}) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <caption className="sr-only">{t('matching.demand.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('matching.demand.role')}</th>
            <th scope="col">{t('matching.demand.openSeats')}</th>
            <th scope="col">{t('matching.demand.teamsSeeking')}</th>
            <th scope="col">{t('matching.demand.queued')}</th>
            <th scope="col">{t('matching.demand.wait')}</th>
            <th scope="col">{t('matching.demand.deficit')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.roleCode}>
              <th scope="row">
                {roles.find((r) => r.code === item.roleCode)?.name ?? item.roleCode}
              </th>
              <td>{item.openSeats}</td>
              <td>{item.teamsSeeking}</td>
              <td>{item.queuedCandidates}</td>
              <td>{waitText(item)}</td>
              <td>
                {item.deficit ? (
                  <span className="tag">{t('matching.demand.deficitYes')}</span>
                ) : (
                  t('matching.demand.deficitNo')
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DemandBars({
  items,
  roles,
}: {
  items: readonly RoleDemand[];
  roles: readonly CatalogEntry[];
}) {
  const most = Math.max(1, ...items.map((item) => item.openSeats));
  return (
    <ul className="demand-bars" aria-hidden="true">
      {items.map((item) => (
        <li key={item.roleCode}>
          <span className="demand-role">
            {roles.find((r) => r.code === item.roleCode)?.name ?? item.roleCode}
          </span>
          <progress className="demand-bar" max={most} value={item.openSeats} />
          <span className="mono muted">
            {t('matching.demand.barLine', {
              seats: item.openSeats,
              queued: item.queuedCandidates,
            })}
          </span>
        </li>
      ))}
    </ul>
  );
}

function DemandLoading() {
  return (
    <div className="row">
      <Yeti pose="think" size={96} />
      <p role="status">{t('matching.demand.loading')}</p>
    </div>
  );
}

function DemandEmpty() {
  return (
    <div className="empty">
      <Yeti pose="sleep" size={96} />
      <p className="muted">{t('matching.demand.empty')}</p>
    </div>
  );
}

/** `/demand`: open seats, queue size and average wait for every role. */
export function DemandPage() {
  const roles = useRoles();
  const codes = roles.data
    ?.filter((r) => r.active)
    .map((r) => r.code)
    .slice(0, MAX_ROLES);
  const demand = useDemand(codes, Boolean(codes));
  if (roles.isError || demand.isError) {
    return (
      <Alert tone="error">
        <p>{t('matching.demand.loadFailed')}</p>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            void roles.refetch();
            void demand.refetch();
          }}
        >
          {t('matching.retry')}
        </button>
      </Alert>
    );
  }
  if (roles.isPending || demand.isPending || !roles.data) {
    return <DemandLoading />;
  }
  if (demand.data.length === 0) {
    return <DemandEmpty />;
  }
  const computed = demand.data[0]?.computedAt;
  return (
    <div className="stack-loose">
      <DemandBars items={demand.data} roles={roles.data} />
      <DemandTable items={demand.data} roles={roles.data} />
      {computed ? (
        <p className="muted">
          {t('matching.demand.updated', { date: new Date(computed).toLocaleString('ru-RU') })}
        </p>
      ) : null}
      <p>
        <Link href="/search" className="button">
          {t('matching.demand.toSearch')}
        </Link>
      </p>
    </div>
  );
}
