'use client';

import { useQuery } from '@tanstack/react-query';
import { t } from '@/i18n';
import { fetchHealth, STATUS_MESSAGES, toApiStatus, type ApiStatus } from './health';

const REFRESH_MS = 30_000;

function StatusIcon({ status }: { status: ApiStatus }) {
  const path =
    status === 'ok'
      ? 'M5 13l4 4L19 7'
      : status === 'checking'
        ? 'M12 6v6l4 2'
        : 'M12 8v5m0 3.5v.01';
  return (
    <svg className="status-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function ApiStatusCard() {
  const query = useQuery({
    queryKey: ['health', 'ready'],
    queryFn: () => fetchHealth(),
    retry: false,
    refetchInterval: REFRESH_MS,
  });
  const status = toApiStatus(query.data, query.isError);
  const message = STATUS_MESSAGES[status];

  return (
    <section className="card" aria-labelledby="api-status-heading">
      <h2 id="api-status-heading">{t('status.heading')}</h2>
      <div className={`status status-${status}`} role="status" aria-live="polite">
        <StatusIcon status={status} />
        <div>
          <p className="status-title">{t(message.title)}</p>
          <p className="muted">{t(message.hint)}</p>
        </div>
      </div>
      <button
        type="button"
        className="button"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        {t('status.retry')}
      </button>
    </section>
  );
}
