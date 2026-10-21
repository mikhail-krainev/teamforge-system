'use client';

import { Alert } from '@/components/ui/Alert';
import { useMe } from '@/features/auth/session';
import { useRoles } from '@/features/profile/useProfileQueries';
import { t } from '@/i18n';
import { describeError } from '@/lib/api/error-message';
import { BadgeCatalog, BadgeList, CounterList } from './AwardsParts';
import { useAwards, useBadges, useCounters } from './queries';

/** Showcase of badges, counters and the catalogue; cosmetic only, nothing here compares users. */
export function AwardsBlock({ userId }: { userId: string }) {
  const awards = useAwards(userId);
  const counters = useCounters(userId);
  const badges = useBadges();
  const roles = useRoles();
  const failed = awards.error ?? counters.error ?? badges.error;

  if (failed) {
    return (
      <section className="card stack" aria-labelledby="awards-title">
        <h2 id="awards-title">{t('rewards.awards.title')}</h2>
        <Alert tone="error">
          <p>{t('rewards.awards.loadFailed')}</p>
          <p className="muted">{describeError(failed)}</p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              void awards.refetch();
              void counters.refetch();
              void badges.refetch();
            }}
          >
            {t('rewards.awards.retry')}
          </button>
        </Alert>
      </section>
    );
  }
  if (!awards.data || !counters.data || !badges.data) {
    return (
      <section className="card stack" aria-labelledby="awards-title" aria-busy="true">
        <h2 id="awards-title">{t('rewards.awards.title')}</h2>
        <p role="status">{t('rewards.awards.loading')}</p>
      </section>
    );
  }
  const roleName = (code: string) => roles.data?.find((role) => role.code === code)?.name ?? code;
  return (
    <section className="card stack" aria-labelledby="awards-title">
      <h2 id="awards-title">{t('rewards.awards.title')}</h2>
      <CounterList counters={counters.data} roleName={roleName} />
      {awards.data.length > 0 ? (
        <BadgeList awards={awards.data} />
      ) : (
        <p className="muted">{t('rewards.awards.received.empty')}</p>
      )}
      <BadgeCatalog badges={badges.data} awards={awards.data} />
    </section>
  );
}

/** The same block on one's own profile page. */
export function OwnAwardsBlock() {
  const me = useMe();
  return me.data ? <AwardsBlock userId={me.data.id} /> : null;
}
