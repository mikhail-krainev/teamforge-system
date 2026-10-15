'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { useMe } from '@/features/auth/session';
import type { CatalogEntry } from '@/features/profile/api';
import { useRoles } from '@/features/profile/useProfileQueries';
import { TeamActions } from '@/features/offers/TeamActions';
import { useTeamChannel } from '@/features/notifications/RealtimeProvider';
import { ApiError } from '@/lib/api/errors';
import { t } from '@/i18n';
import type { Member, Team } from './api';
import { AddSeatsForm } from './AddSeatsForm';
import { useProductTypes, useTeam } from './queries';
import { SeatRow } from './SeatRow';
import { StartProject } from './StartProject';
import { TeamEvents } from './TeamEvents';

function MembersSection({ members }: { members: readonly Member[] }) {
  const active = members.filter((m) => m.status === 'active');
  return (
    <section className="stack" aria-labelledby="team-members-heading">
      <h2 id="team-members-heading">{t('teams.detail.members')}</h2>
      <ul className="stack">
        {active.map((member) => (
          <li key={member.userId} className="card nested">
            <p>
              <Link href={`/users/${member.userId}`}>{member.displayName}</Link>
              {member.isLead ? ` · ${t('teams.detail.lead')}` : ''}
            </p>
            <p className="muted">
              {t('teams.detail.joined', {
                date: new Date(member.joinedAt).toLocaleDateString('ru-RU'),
              })}
              {member.trialUntil
                ? ` · ${t('teams.detail.trialUntil', {
                    date: new Date(member.trialUntil).toLocaleDateString('ru-RU'),
                  })}`
                : ''}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface SeatsProps {
  team: Team;
  roles: readonly CatalogEntry[];
  canManage: boolean;
}

function SeatsSection({ team, roles, canManage }: SeatsProps) {
  const roleName = (code: string) => roles.find((r) => r.code === code)?.name ?? code;
  const holderName = (id: string | null) =>
    id ? team.members.find((m) => m.userId === id)?.displayName : undefined;
  const seats = [...team.seats].sort((a, b) => a.ordinal - b.ordinal);
  return (
    <section className="stack" aria-labelledby="team-seats-heading">
      <h2 id="team-seats-heading">{t('teams.detail.seats')}</h2>
      {seats.length === 0 ? <p className="muted">{t('teams.detail.noSeats')}</p> : null}
      <ul className="stack">
        {seats.map((seat) => (
          <SeatRow
            key={seat.id}
            teamId={team.id}
            seat={seat}
            roleName={roleName(seat.roleCode)}
            holderName={holderName(seat.holderUserId)}
            canManage={canManage}
          />
        ))}
      </ul>
      {canManage ? <AddSeatsForm teamId={team.id} roles={roles} /> : null}
    </section>
  );
}

function Summary({ team, typeName }: { team: Team; typeName: string }) {
  return (
    <section className="card stack" aria-labelledby="team-summary-heading">
      <h2 id="team-summary-heading">{t('teams.detail.about')}</h2>
      <p role="status" aria-live="polite" aria-label={t('teams.detail.statusLabel')}>
        {t('teams.detail.statusLine', { status: t(`teams.status.${team.status}`) })}
      </p>
      {team.statusReason ? <p className="muted">{team.statusReason}</p> : null}
      {team.description ? <p className="pre-text">{team.description}</p> : null}
      <dl className="definition-list">
        <dt>{t('teams.detail.productType')}</dt>
        <dd>{typeName}</dd>
        <dt>{t('teams.detail.timezone')}</dt>
        <dd>{team.timezone}</dd>
        <dt>{t('teams.detail.hours')}</dt>
        <dd>{t('teams.list.hours', { hours: team.hoursPerWeek })}</dd>
        <dt>{t('teams.detail.memberCount')}</dt>
        <dd>{team.memberCount}</dd>
      </dl>
    </section>
  );
}

export function TeamDetailPage({ teamId }: { teamId: string }) {
  const team = useTeam(teamId);
  const me = useMe();
  const roles = useRoles();
  const types = useProductTypes();
  useTeamChannel(teamId);

  if (team.isError) {
    const missing = team.error instanceof ApiError && team.error.status === 404;
    return (
      <Alert tone="error">
        <p>{missing ? t('teams.detail.notFound') : t('teams.detail.loadFailed')}</p>
        {missing ? null : (
          <button type="button" className="button button-secondary" onClick={() => team.refetch()}>
            {t('teams.retry')}
          </button>
        )}
      </Alert>
    );
  }
  if (team.isPending) return <p role="status">{t('teams.detail.loading')}</p>;

  const data = team.data;
  const canManage = Boolean(me.data && data.leadUserId === me.data.id);
  const typeName =
    types.data?.find((p) => p.code === data.productTypeCode)?.name ?? data.productTypeCode;
  return (
    <div className="stack">
      <h1>{data.name}</h1>
      {canManage ? <p className="muted">{t('teams.detail.youAreLead')}</p> : null}
      <Summary team={data} typeName={typeName} />
      <MembersSection members={data.members} />
      <SeatsSection team={data} roles={roles.data ?? []} canManage={canManage} />
      {canManage && data.status === 'forming' ? <StartProject teamId={data.id} /> : null}
      <TeamActions team={data} meId={me.data?.id} roles={roles.data ?? []} isLead={canManage} />
      <TeamEvents teamId={data.id} members={data.members} />
    </div>
  );
}
