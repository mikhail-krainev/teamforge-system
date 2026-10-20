'use client';

import Link from 'next/link';
import { t } from '@/i18n';
import { useTeamChannel } from '@/features/notifications/RealtimeProvider';
import { useTeam } from '@/features/teams/queries';
import type { ProjectStage } from './api';
import { formatDate, isPastDate, sortedStages, stageTitle } from './model';
import { isHiddenError, LoadFailure } from './RouteStates';
import { useStages } from './queries';

function StageDates({ stage }: { stage: ProjectStage }) {
  if (stage.status === 'closed' && stage.closedAt) {
    return <p className="muted">{t('route.closedAt', { date: formatDate(stage.closedAt) })}</p>;
  }
  if (stage.dueAt) {
    return <p className="muted">{t('route.dueUntil', { date: formatDate(stage.dueAt) })}</p>;
  }
  return <p className="muted">{t('route.plannedDuration', { days: stage.durationDays })}</p>;
}

function StageEntry({ teamId, stage }: { teamId: string; stage: ProjectStage }) {
  const isCurrent = stage.status === 'open';
  return (
    <li aria-current={isCurrent ? 'step' : undefined} className="card nested stack">
      <h2>
        <Link href={`/teams/${teamId}/stages/${stage.ordinal}`}>{stageTitle(stage)}</Link>
      </h2>
      <p>
        <strong>{t(`route.status.${stage.status}`)}</strong>
      </p>
      <StageDates stage={stage} />
      {stage.overdue && stage.status === 'open' ? (
        <p className="muted">{t('route.overdue')}</p>
      ) : null}
    </li>
  );
}

export function RoutePage({ teamId }: { teamId: string }) {
  useTeamChannel(teamId);
  const team = useTeam(teamId);
  const stages = useStages(teamId);

  const failed = stages.isError ? stages : team.isError ? team : null;
  if (failed) {
    return (
      <LoadFailure
        hidden={isHiddenError(failed.error)}
        loadFailedKey="route.loadFailed"
        notFoundKey="route.notFound"
        onRetry={() => void failed.refetch()}
      />
    );
  }
  if (!stages.data || !team.data) return <p role="status">{t('route.loading')}</p>;

  const list = sortedStages(stages.data.items);
  const plannedEndAt = stages.data.plannedEndAt ?? null;
  const projectOverdue = team.data.status === 'active' && isPastDate(plannedEndAt, new Date());
  return (
    <div className="stack">
      <h1>{t('route.title')}</h1>
      <p>
        <Link href={`/teams/${teamId}`}>{t('route.back')}</Link>
      </p>
      {list.length === 0 ? <p className="muted">{t('route.notStarted')}</p> : null}
      {plannedEndAt ? <p>{t('route.plannedEnd', { date: formatDate(plannedEndAt) })}</p> : null}
      {projectOverdue ? <p className="muted">{t('route.projectOverdue')}</p> : null}
      {list.length > 0 ? (
        <ol className="stack" aria-label={t('route.timeline')}>
          {list.map((stage) => (
            <StageEntry key={stage.ordinal} teamId={teamId} stage={stage} />
          ))}
        </ol>
      ) : null}
    </div>
  );
}
