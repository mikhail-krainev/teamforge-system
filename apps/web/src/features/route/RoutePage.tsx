'use client';

import Link from 'next/link';
import { Yeti } from '@/components/mascot/Yeti';
import { PageHead } from '@/components/ui/PageHead';
import { t } from '@/i18n';
import { useTeamChannel } from '@/features/notifications/RealtimeProvider';
import { useTeam } from '@/features/teams/queries';
import type { ProjectStage } from './api';
import './route.css';
import { formatDate, isPastDate, sortedStages, stageTitle, stageTone } from './model';
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

function StageEntry({
  teamId,
  stage,
  isLast,
}: {
  teamId: string;
  stage: ProjectStage;
  isLast: boolean;
}) {
  const isCurrent = stage.status === 'open';
  return (
    <li aria-current={isCurrent ? 'step' : undefined} className="route-step">
      <div className={`block block-${stageTone(stage.ordinal)} route-block stack`}>
        {isCurrent ? (
          <span className="sticker sticker-pink route-here" aria-hidden="true">
            {t('route.here')}
          </span>
        ) : null}
        <h2>
          {stage.status === 'closed' ? (
            <span className="route-check" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 18 18">
                <path d="M3 9.5 7 13.5 15 4.5" fill="none" stroke="currentColor" strokeWidth="3" />
              </svg>
            </span>
          ) : null}
          <Link href={`/teams/${teamId}/stages/${stage.ordinal}`}>{stageTitle(stage)}</Link>
        </h2>
        <p>
          <strong>{t(`route.status.${stage.status}`)}</strong>
        </p>
        <StageDates stage={stage} />
        {stage.overdue && stage.status === 'open' ? <p>{t('route.overdue')}</p> : null}
      </div>
      {isLast ? null : <span className="connector" aria-hidden="true" />}
    </li>
  );
}

function RouteLoading() {
  return (
    <div className="row">
      <Yeti pose="think" size={96} />
      <p role="status">{t('route.loading')}</p>
    </div>
  );
}

function NotStarted() {
  return (
    <div className="empty">
      <Yeti pose="sleep" size={96} />
      <p className="muted">{t('route.notStarted')}</p>
    </div>
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
  if (!stages.data || !team.data) {
    return <RouteLoading />;
  }

  const list = sortedStages(stages.data.items);
  const plannedEndAt = stages.data.plannedEndAt ?? null;
  const projectOverdue = team.data.status === 'active' && isPastDate(plannedEndAt, new Date());
  return (
    <div className="stack">
      <PageHead title={t('route.title')}>
        <Link className="text-link" href={`/teams/${teamId}`}>
          {t('route.back')}
        </Link>
      </PageHead>
      {list.length === 0 ? <NotStarted /> : null}
      {plannedEndAt ? <p>{t('route.plannedEnd', { date: formatDate(plannedEndAt) })}</p> : null}
      {projectOverdue ? <p className="muted">{t('route.projectOverdue')}</p> : null}
      {list.length > 0 ? (
        <ol className="route-steps" aria-label={t('route.timeline')}>
          {list.map((stage, index) => (
            <StageEntry
              key={stage.ordinal}
              teamId={teamId}
              stage={stage}
              isLast={index === list.length - 1}
            />
          ))}
        </ol>
      ) : null}
    </div>
  );
}
