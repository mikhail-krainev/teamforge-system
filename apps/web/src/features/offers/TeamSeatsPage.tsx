'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { useMe } from '@/features/auth/session';
import { useRoles } from '@/features/profile/useProfileQueries';
import { useTeam } from '@/features/teams/queries';
import { t } from '@/i18n';
import { DeparturesPanel } from './DeparturesPanel';

/** `/teams/[id]/seats`: seats overview with the departures that wait for the lead's decision. */
export function TeamSeatsPage({ teamId }: { teamId: string }) {
  const team = useTeam(teamId);
  const me = useMe();
  const roles = useRoles();
  const canDecide = Boolean(team.data && me.data && team.data.leadUserId === me.data.id);
  return (
    <div className="stack">
      <h1>{t('offers.seatsPage.title')}</h1>
      <p>
        <Link href={`/teams/${teamId}`}>{t('offers.seatsPage.back')}</Link>
      </p>
      {team.isError ? <Alert tone="error">{t('teams.detail.loadFailed')}</Alert> : null}
      {team.data ? (
        <DeparturesPanel
          teamId={teamId}
          seats={team.data.seats}
          roles={roles.data ?? []}
          canDecide={canDecide}
        />
      ) : null}
    </div>
  );
}
