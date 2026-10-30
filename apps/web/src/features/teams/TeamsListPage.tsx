'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Yeti } from '@/components/mascot/Yeti';
import { useRoles } from '@/features/profile/useProfileQueries';
import { t } from '@/i18n';
import { EMPTY_FILTERS, type TeamSummary } from './api';
import { useProductTypes, useTeamsList } from './queries';
import './teams.css';
import { TeamFiltersForm } from './TeamFiltersForm';

interface CardProps {
  team: TeamSummary;
  roleName: (code: string) => string;
  typeName: string;
}

function SeatsCaption({ taken, total }: { taken: number; total: number }) {
  return (
    <div className="team-seats">
      <span className="mono">{t('teams.list.seatsTaken', { taken, total })}</span>
      <span className="seat-grid" aria-hidden="true">
        {Array.from({ length: total }, (_, index) => (
          <i key={index} className={index < taken ? 'taken' : undefined} />
        ))}
      </span>
    </div>
  );
}

function TeamCard({ team, roleName, typeName }: CardProps) {
  const meta = [
    typeName,
    t('teams.list.members', { count: team.memberCount }),
    team.timezone,
    t('teams.list.hours', { hours: team.hoursPerWeek }),
  ].join(' · ');
  const open = team.openSeats.length;
  const total = team.memberCount + open;
  return (
    <li>
      <div className="team-row">
        <div>
          <h2>
            <Link href={`/teams/${team.id}`}>{team.name}</Link>{' '}
            <span className={`stage-pill team-status-${team.status}`}>
              {t(`teams.status.${team.status}`)}
            </span>
          </h2>
          <p className="muted">{meta}</p>
        </div>
        <SeatsCaption taken={team.memberCount} total={total} />
        <div>
          {open > 0 ? (
            <ul className="tag-list" aria-label={t('teams.list.openSeats')}>
              {team.openSeats.map((seat) => (
                <li key={seat.seatId} className="tag">
                  {`${roleName(seat.roleCode)} · ${t(`teams.level.${seat.minLevel}`)}`}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <span className="icon-button" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 18 18">
            <path
              d="M3 9h11M9.5 4.5 14 9l-4.5 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
        </span>
      </div>
    </li>
  );
}

type ListQuery = ReturnType<typeof useTeamsList>;

function SkeletonRows() {
  return (
    <ul className="team-list" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <li key={index}>
          <div className="team-row team-skeleton">
            <div>
              <span className="skeleton-bar skeleton-title" />
              <span className="skeleton-bar" />
            </div>
            <span className="skeleton-bar" />
            <span className="skeleton-bar" />
            <span />
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmptyTeams({ onReset }: { onReset: () => void }) {
  return (
    <div className="empty">
      <Yeti pose="sleep" size={96} />
      <div className="stack">
        <h3>{t('teams.list.emptyTitle')}</h3>
        <p className="muted">{t('teams.list.empty')}</p>
        <p className="muted">{t('teams.list.emptyHint')}</p>
        <div className="row">
          <button type="button" className="button button-secondary" onClick={onReset}>
            {t('teams.filters.reset')}
          </button>
          <Link href="/teams/new" className="button">
            {t('teams.list.create')}
          </Link>
        </div>
      </div>
    </div>
  );
}

function ListStatus({
  list,
  empty,
  onReset,
}: {
  list: ListQuery;
  empty: boolean;
  onReset: () => void;
}) {
  return (
    <>
      <div aria-live="polite">
        {list.isPending ? (
          <p role="status" className="mono muted">
            <span className="spinner" aria-hidden="true" /> {t('teams.list.loading')}
          </p>
        ) : null}
      </div>
      {list.isPending ? <SkeletonRows /> : null}
      {list.isSuccess && empty ? <EmptyTeams onReset={onReset} /> : null}
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
    <ul className="team-list" aria-label={t('teams.list.title')}>
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
  const [formKey, setFormKey] = useState(0);
  const list = useTeamsList(filters);
  const teams = list.data?.pages.flatMap((page) => page.items) ?? [];
  const reset = () => {
    setFilters(EMPTY_FILTERS);
    setFormKey((key) => key + 1);
  };
  return (
    <div className="stack teams-page">
      <TeamFiltersForm
        key={formKey}
        applied={filters}
        onApply={setFilters}
        count={list.isSuccess && !list.hasNextPage ? teams.length : undefined}
      />
      <ListStatus list={list} empty={teams.length === 0} onReset={reset} />
      <TeamCards teams={teams} />
      <LoadMore list={list} />
    </div>
  );
}
