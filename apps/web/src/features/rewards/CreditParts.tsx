import { t } from '@/i18n';
import type { CreditRow, CreditStatus } from './api';
import { creditReason, formatCountdown } from './model';

export function StatusBlock({ credit, now }: { credit: CreditStatus; now: Date }) {
  return (
    <section className="card stack" aria-labelledby="credit-status-title">
      <h2 id="credit-status-title">{t('rewards.credit.statusLabel')}</h2>
      <p role="status" aria-label={t('rewards.credit.statusLabel')} className="credit-status">
        {t(`rewards.credit.status.${credit.status}`)}
      </p>
      <p className="muted">{t(`rewards.credit.statusHint.${credit.status}`)}</p>
      {credit.status === 'cooling' || credit.status === 'frozen' ? (
        <Countdown until={credit.coolingUntil} now={now} />
      ) : null}
    </section>
  );
}

function Countdown({ until, now }: { until: string; now: Date }) {
  const value = formatCountdown(until, now);
  if (value === null) return <p className="muted">{t('rewards.credit.countdown.ended')}</p>;
  return (
    <p role="timer" aria-label={t('rewards.credit.countdown.label')} className="credit-countdown">
      <span className="muted">{t('rewards.credit.countdown.label')}: </span>
      <strong>{value}</strong>
    </p>
  );
}

export function MyCredits({
  rows,
  roleName,
}: {
  rows: readonly CreditRow[];
  roleName: (code: string) => string;
}) {
  return (
    <section className="stack" aria-labelledby="credit-mine-title">
      <h2 id="credit-mine-title">{t('rewards.credit.myCredits.title')}</h2>
      {rows.length === 0 ? (
        <p className="muted">{t('rewards.credit.myCredits.empty')}</p>
      ) : (
        <ul className="stack plain-list" aria-label={t('rewards.credit.myCredits.title')}>
          {rows.map((row) => (
            <CreditRowItem key={row.roleCode} row={row} name={roleName(row.roleCode)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CreditRowItem({ row, name }: { row: CreditRow; name: string }) {
  const reason = creditReason(row);
  return (
    <li className="card nested">
      <strong>{name}</strong>: <span>{t(`rewards.credit.rowStatus.${row.status}`)}</span>
      {reason ? <p className="muted">{reason}</p> : null}
    </li>
  );
}
