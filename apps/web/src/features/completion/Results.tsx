'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { ContributionByRole } from './ContributionByRole';
import { useCompletion } from './queries';
import { formatDate } from '@/features/route/model';
import type { Team } from '@/features/teams/api';
import { t } from '@/i18n';
import type { Completion } from './api';

type RoleNameOf = (code: string) => string;

function OverdueLine({ completion }: { completion: Completion }) {
  return (
    <p>
      <strong>
        {completion.overdueDays > 0
          ? t('completion.results.overdue', { days: completion.overdueDays })
          : t('completion.results.onTime')}
      </strong>
    </p>
  );
}

function CreditLine({ completion }: { completion: Completion }) {
  const { status, coolingUntil } = completion.credit;
  return (
    <p>
      {status === 'cooling'
        ? t('completion.results.credit.cooling', { date: formatDate(coolingUntil) })
        : t(`completion.results.credit.${status}`)}
    </p>
  );
}

function Composition({ team, roleName }: { team: Team; roleName: RoleNameOf }) {
  const members = team.members.filter((member) => member.status === 'active');
  return (
    <section className="stack" aria-labelledby="results-composition">
      <h2 id="results-composition">{t('completion.results.composition')}</h2>
      <ul className="stack">
        {members.map((member) => (
          <li key={member.userId}>
            {member.displayName}
            {member.isLead ? ` (${t('completion.results.lead')})` : ''}
            {member.roles.length > 0 ? ` · ${member.roles.map(roleName).join(', ')}` : ''}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Results of a completed project (FR-WORK-15): the same for every participant. */
export function Results({ team, roleName }: { team: Team; roleName: RoleNameOf }) {
  const completion = useCompletion(team.id, true);
  if (completion.isError) {
    return (
      <Alert tone="error">
        <p>{t('completion.results.loadFailed')}</p>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void completion.refetch()}
        >
          {t('completion.retry')}
        </button>
      </Alert>
    );
  }
  if (!completion.data) return <p role="status">{t('completion.results.loading')}</p>;
  const data = completion.data;
  return (
    <div className="stack">
      <h1>{t('completion.results.title')}</h1>
      <p className="muted">{t('completion.results.intro')}</p>
      <div className="card stack">
        <p>{t('completion.results.completedAt', { date: formatDate(data.completedAt) })}</p>
        <p className="muted">
          {t('completion.results.plannedEnd', { date: formatDate(data.plannedEndAt) })}
        </p>
        <OverdueLine completion={data} />
        <p className="muted">{t('completion.results.overdueNote')}</p>
      </div>
      <section className="stack" aria-labelledby="results-credit">
        <h2 id="results-credit">{t('completion.results.credit.title')}</h2>
        <CreditLine completion={data} />
      </section>
      <Composition team={team} roleName={roleName} />
      <ContributionByRole team={team} roleName={roleName} />
      <p className="row">
        <Link href={`/teams/${team.id}/feed`}>{t('completion.results.toFeed')}</Link>
        <Link href={`/teams/${team.id}/route`}>{t('completion.results.toRoute')}</Link>
      </p>
    </div>
  );
}
