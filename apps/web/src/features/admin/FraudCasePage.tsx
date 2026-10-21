'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { formatDateTimeDay } from '@/features/reviews/model';
import { t } from '@/i18n';
import { describeError } from '@/lib/api/error-message';
import { ApiError } from '@/lib/api/errors';
import type { FraudCase } from './api';
import { DecisionPanel } from './DecisionPanel';
import { useAdminGuard, useCase } from './queries';

function Signals({ signals }: { signals: FraudCase['signals'] }) {
  if (signals.length === 0) return <p className="muted">{t('fraud.card.noSignals')}</p>;
  return (
    <ul className="stack plain-list" aria-label={t('fraud.card.signals')}>
      {signals.map((signal) => (
        <li key={signal.ruleCode}>
          <strong>{signal.ruleCode}</strong>{' '}
          <span className="muted">
            {t('fraud.card.signalLine', {
              score: signal.score,
              action: t(`fraud.card.action.${signal.action}`),
            })}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Disputes({ disputes }: { disputes: NonNullable<FraudCase['disputes']> }) {
  if (disputes.length === 0) return <p className="muted">{t('fraud.card.noDisputes')}</p>;
  return (
    <ul className="stack plain-list" aria-label={t('fraud.card.disputes')}>
      {disputes.map((dispute, index) => (
        <li key={`${dispute.createdAt}-${index}`} className="card nested">
          <p className="review-text">{dispute.text}</p>
          <p className="muted">
            {t('fraud.card.disputeDate', { date: formatDateTimeDay(dispute.createdAt) })}
          </p>
        </li>
      ))}
    </ul>
  );
}

function Card({ item }: { item: FraudCase }) {
  return (
    <section className="card stack" aria-labelledby="fraud-card-title">
      <h2 id="fraud-card-title">{t('fraud.card.label')}</h2>
      <p>
        <strong>{item.teamName}</strong>
        <br />
        <span className="muted">
          {t('fraud.card.opened', { date: formatDateTimeDay(item.openedAt) })}
        </span>
      </p>
      <h3>{t('fraud.card.signals')}</h3>
      <Signals signals={item.signals} />
      <h3>{t('fraud.card.disputes')}</h3>
      <Disputes disputes={item.disputes ?? []} />
      <h3>{t('fraud.decision.title')}</h3>
      <DecisionPanel item={item} />
    </section>
  );
}

/** `/admin/fraud/[id]`: the case, the rules that fired, the complaints and the decision. */
export function FraudCasePage({ caseId }: { caseId: string }) {
  const allowed = useAdminGuard();
  const query = useCase(caseId);
  if (!allowed) return null;
  if (query.isPending) return <p role="status">{t('fraud.loading')}</p>;
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <Alert tone="error">
        <p>{missing ? t('fraud.notFound') : t('fraud.loadFailed')}</p>
        {missing ? null : <p className="muted">{describeError(query.error)}</p>}
      </Alert>
    );
  }
  return (
    <div className="stack">
      <h1>{t('fraud.title')}</h1>
      <p>
        <Link href="/admin/fraud">{t('fraud.card.back')}</Link>
      </p>
      <Card item={query.data} />
    </div>
  );
}
