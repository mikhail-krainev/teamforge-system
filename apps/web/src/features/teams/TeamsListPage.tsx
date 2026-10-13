'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { useRoles } from '@/features/profile/useProfileQueries';
import { t } from '@/i18n';
import { EMPTY_FILTERS, type TeamSummary } from './api';
import { useProductTypes, useTeamsList } from './queries';
import { TeamFiltersForm } from './TeamFiltersForm';

interface CardProps {
  team: TeamSummary;
  roleName: (code: string) => string;
  typeName: string;
}

function TeamCard({ team, roleName, typeName }: CardProps) {
  const meta = [
    typeName,
    t(`teams.status.${team.status}`),
    t('teams.list.members', { count: team.memberCount }),
    team.timezone,
    t('teams.list.hours', { hours: team.hoursPerWeek }),
  ].join(' · ');
  return (
    <li className="card stack">
      <h2>
        <Link href={`/teams/${team.id}`}>{team.name}</Link>
      </h2>
      <p className="muted">{meta}</p>
      {team.openSeats.length > 0 ? (
        <>
          <p>{t('teams.list.openSeats')}</p>
          <ul className="tag-list">
            {team.openSeats.map((seat) => (
              <li key={seat.seatId} className="tag">
                {`${roleName(seat.roleCode)} · ${t(`teams.level.${seat.minLevel}`)}`}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </li>
  );
}

type ListQuery = ReturnType<typeof useTeamsList>;

function ListStatus({ list, empty }: { list: ListQuery; empty: boolean }) {
  return (
    <>
      <div aria-live="polite">
        {list.isPending ? <p role="status">{t('teams.list.loading')}</p> : null}
        {list.isSuccess && empty ? <p className="muted">{t('teams.list.empty')}</p> : null}
      </div>
      {list.isError ? (
        <Alert tone="error">
          <p>{t('teams.list.loadFailed')}</p>
          <button type="button" className="button button-secondary" onClick={() => list.refetch()}>
            {t('teams.retry')}
          </button>
        </Alert>
      ) : null}
    </>
  );
}

function LoadMore({ list }: { list: ListQuery }) {
  if (!list.hasNextPage) return null;
  return (
    <div>
      <button
        type="button"
        className="button button-secondary"
        disabled={list.isFetchingNextPage}
        onClick={() => list.fetchNextPage()}
      >
        {list.isFetchingNextPage ? t('teams.list.loadingMore') : t('teams.list.loadMore')}
      </button>
    </div>
  );
}

function TeamCards({ teams }: { teams: TeamSummary[] }) {
  const roles = useRoles();
  const types = useProductTypes();
  const roleName = (code: string) => roles.data?.find((r) => r.code === code)?.name ?? code;
  const typeName = (code: string) => types.data?.find((p) => p.code === code)?.name ?? code;
  if (teams.length === 0) return null;
  return (
    <ul className="stack" aria-label={t('teams.list.title')}>
      {teams.map((team) => (
        <TeamCard
          key={team.id}
          team={team}
          roleName={roleName}
          typeName={typeName(team.productTypeCode)}
        />
      ))}
    </ul>
  );
}

export function TeamsListPage() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const list = useTeamsList(filters);
  const teams = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="stack">
      <div className="row">
        <Link href="/teams/new" className="button">
          {t('teams.list.create')}
        </Link>
      </div>
      <TeamFiltersForm applied={filters} onApply={setFilters} />
      <ListStatus list={list} empty={teams.length === 0} />
      <TeamCards teams={teams} />
      <LoadMore list={list} />
    </div>
  );
}
