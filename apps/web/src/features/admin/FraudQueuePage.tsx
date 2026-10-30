'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { PageHead } from '@/components/ui/PageHead';
import { Field } from '@/components/ui/Field';
import { formatDateTimeDay } from '@/features/reviews/model';
import { t } from '@/i18n';
import { describeError } from '@/lib/api/error-message';
import type { FraudStatus } from './api';
import { useAdminGuard, useCases } from './queries';

const STATUSES: FraudStatus[] = ['open', 'ok', 'violation'];

function Queue({ status }: { status: FraudStatus }) {
  const query = useCases(status);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  if (query.isPending) return <p role="status">{t('fraud.loading')}</p>;
  if (query.isError) {
    return (
      <Alert tone="error">
        <p>{t('fraud.loadFailed')}</p>
        <p className="muted">{describeError(query.error)}</p>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void query.refetch()}
        >
          {t('fraud.retry')}
        </button>
      </Alert>
    );
  }
  if (items.length === 0) return <p className="muted">{t('fraud.queue.empty')}</p>;
  return (
    <>
      <ul className="stack plain-list" aria-label={t('fraud.queue.label')}>
        {items.map((item) => (
          <li key={item.id} className="card nested stack">
            <strong>{item.teamName}</strong>
            <span className="muted">
              {t('fraud.queue.opened', { date: formatDateTimeDay(item.openedAt) })}
            </span>
            <Link href={`/admin/fraud/${item.id}`}>{t('fraud.queue.open')}</Link>
          </li>
        ))}
      </ul>
      {query.hasNextPage ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t('fraud.queue.more')}
        </button>
      ) : null}
    </>
  );
}

/** `/admin/fraud`: the queue of the manual review (administrators only, UX redirect). */
export function FraudQueuePage() {
  const allowed = useAdminGuard();
  const id = useId();
  const [status, setStatus] = useState<FraudStatus>('open');
  if (!allowed) return null;
  return (
    <div className="stack">
      <PageHead title={t('fraud.title')} lead={t('fraud.lead')} />
      <Field id={`${id}-status`} label={t('fraud.queue.filter')}>
        {(control) => (
          <select
            {...control}
            value={status}
            onChange={(event) => setStatus(event.target.value as FraudStatus)}
          >
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`fraud.queue.status.${value}`)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Queue status={status} />
    </div>
  );
}
