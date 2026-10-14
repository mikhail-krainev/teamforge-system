'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { CatalogEntry } from '@/features/profile/api';
import type { Team } from '@/features/teams/api';
import { t } from '@/i18n';
import { JoinRequestForm } from './JoinRequestForm';
import { LeaveTeam, LeftNotice } from './LeaveTeam';

interface Props {
  team: Team;
  meId: string | undefined;
  roles: readonly CatalogEntry[];
  isLead: boolean;
}

/** Offers, invitations, leaving and join requests, as seen from the team detail page. */
export function TeamActions({ team, meId, roles, isLead }: Props) {
  const [left, setLeft] = useState(false);
  if (!meId) return null;
  // Remembered here: after the refetch the user is no longer a member and LeaveTeam is gone.
  if (left) return <LeftNotice />;
  const member = team.members.some((m) => m.userId === meId && m.status === 'active');
  if (!member) return <JoinRequestForm teamId={team.id} seats={team.seats} roles={roles} />;
  return (
    <section className="stack" aria-labelledby="team-actions-heading">
      <h2 id="team-actions-heading">{t('offers.actions.title')}</h2>
      <nav aria-label={t('offers.actions.title')} className="row">
        {isLead ? (
          <>
            <Link href={`/teams/${team.id}/offers`} className="button button-secondary">
              {t('offers.actions.offers')}
            </Link>
            <Link href={`/teams/${team.id}/invitations`} className="button button-secondary">
              {t('offers.actions.invitations')}
            </Link>
          </>
        ) : null}
        {team.status === 'voting' ? (
          <Link href={`/teams/${team.id}/vote`} className="button">
            {t('offers.actions.vote')}
          </Link>
        ) : null}
        <Link href={`/teams/${team.id}/seats`} className="button button-secondary">
          {t('offers.actions.seats')}
        </Link>
      </nav>
      <LeaveTeam teamId={team.id} onLeft={() => setLeft(true)} />
    </section>
  );
}
