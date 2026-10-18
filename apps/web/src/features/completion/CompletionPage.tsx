'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { useMe } from '@/features/auth/session';
import { useTeamChannel } from '@/features/notifications/RealtimeProvider';
import { useRoles } from '@/features/profile/useProfileQueries';
import { isHiddenError } from '@/features/route/RouteStates';
import { sortedStages } from '@/features/route/model';
import { useStages } from '@/features/route/queries';
import type { Team } from '@/features/teams/api';
import { useTeam } from '@/features/teams/queries';
import { t } from '@/i18n';
import { ChecksPanel } from './ChecksPanel';
import { FinishPanel } from './FinishPanel';
import { isCheckGreen } from './model';
import { useLatestCheck } from './queries';
import { ReleaseLink } from './ReleaseLink';
import { Results } from './Results';
import { useNow } from './useNow';

function PageFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const hidden = isHiddenError(error);
  return (
    <Alert tone="error">
      <p>{t(hidden ? 'completion.notFound' : 'completion.loadFailed')}</p>
      {hidden ? null : (
        <button type="button" className="button button-secondary" onClick={onRetry}>
          {t('completion.retry')}
        </button>
      )}
    </Alert>
  );
}

function StagesSummary({ teamId }: { teamId: string }) {
  const stages = useStages(teamId);
  if (!stages.data) return null;
  const list = sortedStages(stages.data.items);
  const closed = list.filter((stage) => stage.status === 'closed').length;
  return (
    <section className="stack" aria-labelledby="complete-stages">
      <h2 id="complete-stages">{t('completion.stages.title')}</h2>
      <p>{t('completion.stages.progress', { closed, total: list.length })}</p>
      <p className="muted">
        {closed === list.length && list.length > 0
          ? t('completion.stages.allClosed')
          : t('completion.stages.someOpen')}
      </p>
      <p>
        <Link href={`/teams/${teamId}/route`}>{t('completion.stages.route')}</Link>
      </p>
    </section>
  );
}

function Wizard({ team, isLead }: { team: Team; isLead: boolean }) {
  const latest = useLatestCheck(team.id);
  const now = useNow();
  const suspended = team.status === 'suspended';
  const canFinish = isLead && team.status === 'active' && isCheckGreen(latest.data, now);
  return (
    <div className="stack">
      <h1>{t('completion.title')}</h1>
      <p>
        <Link href={`/teams/${team.id}`}>{t('completion.back')}</Link>
      </p>
      {team.status === 'forming' ? <p className="muted">{t('completion.notStarted')}</p> : null}
      {team.status === 'voting' || suspended ? (
        <Alert tone="warn">{t('completion.blockedStatus')}</Alert>
      ) : null}
      {isLead ? null : <p className="muted">{t('completion.leadOnly')}</p>}
      <StagesSummary teamId={team.id} />
      <section className="stack" aria-labelledby="complete-release">
        <h2 id="complete-release">{t('completion.release.title')}</h2>
        <ReleaseLink teamId={team.id} suspended={suspended} />
      </section>
      <section className="stack" aria-labelledby="complete-checks">
        <h2 id="complete-checks">{t('completion.checks.title')}</h2>
        <ChecksPanel teamId={team.id} isLead={isLead} />
      </section>
      {isLead ? (
        <section className="stack" aria-labelledby="complete-finish">
          <h2 id="complete-finish">{t('completion.finish.title')}</h2>
          <FinishPanel teamId={team.id} enabled={canFinish} />
        </section>
      ) : null}
    </div>
  );
}

/** The completion wizard of the lead (release link, checks, "Завершить проект") and the results screen. */
export function CompletionPage({ teamId }: { teamId: string }) {
  useTeamChannel(teamId);
  const me = useMe();
  const team = useTeam(teamId);
  const roles = useRoles();
  if (team.isError) return <PageFailure error={team.error} onRetry={() => void team.refetch()} />;
  if (!team.data) return <p role="status">{t('completion.loading')}</p>;
  const roleName = (code: string) => roles.data?.find((role) => role.code === code)?.name ?? code;
  if (team.data.status === 'completed') return <Results team={team.data} roleName={roleName} />;
  const isLead = Boolean(me.data && team.data.leadUserId === me.data.id);
  return <Wizard team={team.data} isLead={isLead} />;
}
