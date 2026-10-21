import { t } from '@/i18n';
import type { Award, Badge, Counters } from './api';
import { stepLabel } from './model';

export function BadgeList({ awards }: { awards: readonly Award[] }) {
  return (
    <ul className="award-list" aria-label={t('rewards.awards.received.label')}>
      {awards.map((award) => (
        <li key={`${award.badgeCode}-${award.teamId ?? ''}`} className="award">
          <strong>{award.name}</strong>
          {award.step == null ? null : <span className="muted">{stepLabel(award)}</span>}
          {award.teamName ? (
            <span className="muted">{t('rewards.awards.team', { team: award.teamName })}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function CounterList({
  counters,
  roleName,
}: {
  counters: Counters;
  roleName: (code: string) => string;
}) {
  return (
    <section className="stack" aria-label={t('rewards.awards.counters.label')}>
      <h3>{t('rewards.awards.counters.label')}</h3>
      <ul className="plain-list">
        <li>{t('rewards.awards.counters.total', { value: counters.total })}</li>
        {counters.byRole.map((row) => (
          <li key={row.roleCode}>
            {t('rewards.awards.counters.byRole', {
              role: roleName(row.roleCode),
              value: row.value,
            })}
          </li>
        ))}
      </ul>
      {counters.productTypes.length > 0 ? (
        <p className="muted">
          {t('rewards.awards.counters.productTypes', { types: counters.productTypes.join(', ') })}
        </p>
      ) : null}
    </section>
  );
}

function catalogState(badge: Badge, earned: ReadonlySet<string>): string {
  if (earned.has(badge.code)) return t('rewards.awards.catalog.got');
  return badge.available
    ? t('rewards.awards.catalog.open')
    : t('rewards.awards.catalog.unavailable');
}

/** The whole catalogue with the state of each badge: earned, not earned, unavailable. */
export function BadgeCatalog({
  badges,
  awards,
}: {
  badges: readonly Badge[];
  awards: readonly Award[];
}) {
  const earned = new Set(awards.map((award) => award.badgeCode));
  return (
    <section className="stack" aria-label={t('rewards.awards.catalog.label')}>
      <h3>{t('rewards.awards.catalog.label')}</h3>
      <ul className="award-list">
        {badges.map((badge) => (
          <li
            key={badge.code}
            className={badge.available ? 'award' : 'award award-unavailable'}
          >
            <strong>{badge.name}</strong>
            {badge.step == null ? null : <span className="muted">{stepLabel(badge)}</span>}
            {badge.scope === 'team' ? (
              <span className="muted">{t('rewards.awards.catalog.team')}</span>
            ) : null}
            <span className="award-state">{catalogState(badge, earned)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
