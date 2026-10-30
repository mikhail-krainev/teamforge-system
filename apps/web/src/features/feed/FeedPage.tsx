'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { PageHead } from '@/components/ui/PageHead';
import { useMe } from '@/features/auth/session';
import { ContributionSummary } from '@/features/contribution/ContributionSummary';
import { useTeamChannel } from '@/features/notifications/RealtimeProvider';
import { useRoles } from '@/features/profile/useProfileQueries';
import { isHiddenError } from '@/features/route/RouteStates';
import { useTeam } from '@/features/teams/queries';
import { memberNameOf } from '@/features/contribution/model';
import { t } from '@/i18n';
import { EMPTY_FEED_FILTERS } from './api';
import { FeedFilters } from './FeedFilters';
import { FeedList } from './FeedList';

const FROZEN_STATUSES = new Set(['completed', 'archived']);

function TeamFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const hidden = isHiddenError(error);
  return (
    <Alert tone="error">
      <p>{t(hidden ? 'feed.notFound' : 'feed.loadFailed')}</p>
      {hidden ? null : (
        <button type="button" className="button button-secondary" onClick={onRetry}>
          {t('feed.retry')}
        </button>
      )}
    </Alert>
  );
}

/** Feed of the team's work with the contribution summary; live through `contribution.recorded`. */
export function FeedPage({ teamId }: { teamId: string }) {
  useTeamChannel(teamId);
  const [filters, setFilters] = useState(EMPTY_FEED_FILTERS);
  const me = useMe();
  const team = useTeam(teamId);
  const roles = useRoles();

  if (team.isError) return <TeamFailure error={team.error} onRetry={() => void team.refetch()} />;
  if (!team.data) return <p role="status">{t('feed.loading')}</p>;

  const members = team.data.members;
  const meId = me.data?.id;
  const roleName = (code: string) => roles.data?.find((role) => role.code === code)?.name ?? code;
  const context = {
    teamId,
    nameOf: memberNameOf(members),
    roleName,
    meId,
    myRoleCodes: members.find((member) => member.userId === meId)?.roles ?? [],
    canRelabel: !FROZEN_STATUSES.has(team.data.status),
  };
  return (
    <div className="stack">
      <PageHead title={t('feed.title')}>
        <Link className="text-link" href={`/teams/${teamId}`}>
          {t('feed.back')}
        </Link>
      </PageHead>
      <p className="muted">{t('feed.updated')}</p>
      <ContributionSummary teamId={teamId} members={members} roleName={roleName} />
      <FeedFilters filters={filters} members={members} onChange={setFilters} />
      <FeedList teamId={teamId} filters={filters} context={context} />
    </div>
  );
}
