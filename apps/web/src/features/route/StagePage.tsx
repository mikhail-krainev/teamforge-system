'use client';

import Link from 'next/link';
import { useState } from 'react';
import { t } from '@/i18n';
import { useMe } from '@/features/auth/session';
import { ChecklistItemCard, type ItemContext } from '@/features/checklist/ChecklistItemCard';
import { useTeamChannel } from '@/features/notifications/RealtimeProvider';
import type { Team } from '@/features/teams/api';
import { useTeam } from '@/features/teams/queries';
import { ParticipationConfirm } from '@/features/transition/ParticipationConfirm';
import { TransitionControl } from '@/features/transition/TransitionControl';
import type { ChecklistItem, Playbook, PlaybookStep, ProjectStage } from './api';
import { formatDate, nextStage, stageTitle, stepsByKey } from './model';
import { useChecklist, usePlaybook, useStages } from './queries';
import { isHiddenError, LoadFailure } from './RouteStates';

interface ViewProps {
  team: Team;
  stage: ProjectStage;
  stages: readonly ProjectStage[];
  items: readonly ChecklistItem[];
  playbook: Playbook | undefined;
  meId: string;
}

function StageNotice({ stage, suspended }: { stage: ProjectStage; suspended: boolean }) {
  if (suspended) return <p className="muted">{t('route.stage.suspendedNotice')}</p>;
  if (stage.status === 'pending') return <p className="muted">{t('route.stage.pendingNotice')}</p>;
  if (stage.status === 'closed') return <p className="muted">{t('route.stage.closedNotice')}</p>;
  return null;
}

function StageHeader({ stage, playbook }: { stage: ProjectStage; playbook: Playbook | undefined }) {
  const definition = playbook?.stages.find((s) => s.ordinal === stage.ordinal);
  return (
    <>
      <h1>{stageTitle(stage)}</h1>
      <p>
        <strong>{t(`route.status.${stage.status}`)}</strong>
      </p>
      {stage.dueAt && stage.status === 'open' ? (
        <p>{t('route.dueUntil', { date: formatDate(stage.dueAt) })}</p>
      ) : null}
      {stage.overdue && stage.status === 'open' ? (
        <p className="muted">{t('route.overdue')}</p>
      ) : null}
      {definition ? (
        <p className="muted">{t('route.stage.goal', { goal: definition.goal })}</p>
      ) : null}
      {definition ? (
        <p className="muted">{t('route.stage.exit', { criteria: definition.exitCriteria })}</p>
      ) : null}
    </>
  );
}

/**
 * Stays on the page the lead opened until the lead acts: if another tab or participant moves the
 * project on meanwhile, the server answers STAGE_NOT_OPEN to the click instead of the button
 * vanishing from under the cursor.
 */
function TransitionSection({
  view,
  reviewKeys,
}: {
  view: ViewProps;
  reviewKeys: ReadonlySet<string>;
}) {
  const [wasOpen] = useState(view.stage.status === 'open');
  const next = nextStage(view.stages, view.stage.ordinal);
  if (!wasOpen || !next) return null;
  return (
    <section className="stack" aria-labelledby="stage-transition-heading">
      <h2 id="stage-transition-heading">{t('transition.heading')}</h2>
      <TransitionControl
        teamId={view.team.id}
        stage={view.stage}
        nextOrdinal={next.ordinal}
        items={view.items}
        reviewKeys={reviewKeys}
      />
    </section>
  );
}

function reviewKeysOf(steps: ReadonlyMap<string, PlaybookStep>): ReadonlySet<string> {
  return new Set(
    [...steps.values()].filter((step) => step.reviewChecklist).map((step) => step.key),
  );
}

function itemContext({ team, stage, meId }: ViewProps, isLead: boolean): ItemContext {
  return {
    teamId: team.id,
    meId,
    isLead,
    members: team.members,
    editable: stage.status === 'open' && team.status !== 'suspended',
  };
}

function StageView(view: ViewProps) {
  const { team, stage, items, playbook } = view;
  const isLead = team.leadUserId === view.meId;
  const suspended = team.status === 'suspended';
  const steps = stepsByKey(playbook, stage.ordinal);
  const reviewKeys = reviewKeysOf(steps);
  const context = itemContext(view, isLead);
  return (
    <div className="stack">
      <StageHeader stage={stage} playbook={playbook} />
      <p>
        <Link href={`/teams/${team.id}/route`}>{t('route.stage.back')}</Link>
      </p>
      <StageNotice stage={stage} suspended={suspended} />
      <section className="stack" aria-labelledby="stage-checklist-heading">
        <h2 id="stage-checklist-heading">{t('route.stage.checklistHeading')}</h2>
        {items.length === 0 ? <p className="muted">{t('route.stage.empty')}</p> : null}
        <ul className="stack" aria-label={t('route.stage.checklist')}>
          {items.map((item) => (
            <ChecklistItemCard
              key={item.id}
              item={item}
              step={steps.get(item.stepKey)}
              context={context}
            />
          ))}
        </ul>
      </section>
      {isLead ? (
        <TransitionSection view={view} reviewKeys={reviewKeys} />
      ) : stage.status === 'open' ? (
        <p className="muted">{t('transition.leadOnly')}</p>
      ) : null}
      {isLead && stage.status !== 'pending' ? (
        <ParticipationConfirm
          teamId={team.id}
          stageOrdinal={stage.ordinal}
          members={team.members}
        />
      ) : null}
    </div>
  );
}

export function StagePage({ teamId, ordinal }: { teamId: string; ordinal: number }) {
  useTeamChannel(teamId);
  const me = useMe();
  const team = useTeam(teamId);
  const stages = useStages(teamId);
  const stage = stages.data?.items.find((s) => s.ordinal === ordinal);
  // A stage that has not opened has no items yet: nothing to read.
  const checklist = useChecklist(
    teamId,
    ordinal,
    stage !== undefined && stage.status !== 'pending',
  );
  const playbook = usePlaybook(team.data?.playbookId);

  const failed = [stages, team, checklist].find((query) => query.isError);
  if (failed) {
    return (
      <LoadFailure
        hidden={isHiddenError(failed.error)}
        loadFailedKey="route.stage.loadFailed"
        notFoundKey="route.stage.notFound"
        onRetry={() => void failed.refetch()}
      />
    );
  }
  if (!stages.data || !team.data || !me.data) {
    return <p role="status">{t('route.stage.loading')}</p>;
  }
  if (!stage) {
    return (
      <LoadFailure
        hidden
        loadFailedKey="route.stage.loadFailed"
        notFoundKey="route.stage.notFound"
        onRetry={() => undefined}
      />
    );
  }
  if (stage.status !== 'pending' && !checklist.data) {
    return <p role="status">{t('route.stage.loading')}</p>;
  }
  return (
    <StageView
      team={team.data}
      stage={stage}
      stages={stages.data.items}
      items={checklist.data ?? []}
      playbook={playbook.data}
      meId={me.data.id}
    />
  );
}
