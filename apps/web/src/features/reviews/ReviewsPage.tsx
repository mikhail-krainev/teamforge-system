'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { useMe } from '@/features/auth/session';
import { t } from '@/i18n';
import { describeError } from '@/lib/api/error-message';
import type { MyTeam } from './api';
import { ReviewForm, type Colleague } from './ReviewForm';
import { ReceivedReviews, SentReviews } from './ReviewLists';
import { useFinishedTeams, useProjectMembers, useSentReviews } from './queries';

function ProjectReviews({ teams }: { teams: readonly MyTeam[] }) {
  const [teamId, setTeamId] = useState(teams[0]?.team.id ?? '');
  const me = useMe();
  const sent = useSentReviews(teamId);
  const project = useProjectMembers(teamId);
  const members = project.data?.members ?? [];
  const nameOf = (userId: string) =>
    members.find((member) => member.userId === userId)?.displayName ?? t('reviews.sent.colleague');
  const done = new Set(sent.data?.items.map((item) => item.subjectUserId));
  const colleagues: Colleague[] = members
    .filter((m) => m.status === 'active' && m.userId !== me.data?.id && !done.has(m.userId))
    .map((m) => ({ userId: m.userId, name: m.displayName }));

  if (sent.isPending || project.isPending) return <p role="status">{t('reviews.loading')}</p>;
  if (sent.isError || project.isError) {
    return <Alert tone="error">{describeError(sent.error ?? project.error)}</Alert>;
  }
  return (
    <>
      {sent.data === null ? (
        <Alert tone="info">{t('reviews.notEligible')}</Alert>
      ) : (
        <ReviewForm
          teams={teams}
          teamId={teamId}
          onTeamChange={setTeamId}
          colleagues={colleagues}
          windowClosesAt={sent.data.windowClosesAt}
        />
      )}
      <SentReviews sent={sent.data} nameOf={nameOf} />
    </>
  );
}

/** `/reviews`: write a review, the received ones (no author) and the sent ones. */
export function ReviewsPage() {
  const finished = useFinishedTeams();
  return (
    <div className="stack">
      <h1>{t('reviews.title')}</h1>
      <p className="lead">{t('reviews.lead')}</p>
      <p className="muted">{t('reviews.batchHint')}</p>
      {finished.isPending ? <p role="status">{t('reviews.loading')}</p> : null}
      {finished.isError ? <Alert tone="error">{describeError(finished.error)}</Alert> : null}
      {finished.data && finished.data.length === 0 ? (
        <p className="muted">{t('reviews.noProjects')}</p>
      ) : null}
      {finished.data && finished.data.length > 0 ? <ProjectReviews teams={finished.data} /> : null}
      <ReceivedReviews />
    </div>
  );
}
