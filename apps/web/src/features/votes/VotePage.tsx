'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { useMe } from '@/features/auth/session';
import { ActionErrorAlert } from '@/features/offers/ActionErrorAlert';
import { useTeamChannel } from '@/features/notifications/RealtimeProvider';
import type { Team } from '@/features/teams/api';
import { useTeam } from '@/features/teams/queries';
import { t } from '@/i18n';
import { ApiError } from '@/lib/api/errors';
import type { LeaderVote } from './api';
import { CandidateList } from './CandidateList';
import { pickVote } from './model';
import { PhaseBanner } from './PhaseBanner';
import { useVoteRequests, useVotes } from './queries';
import { useRequestVote } from './useVoteActions';
import { VoteActions } from './VoteActions';

function Outcome({ vote, nameOf }: { vote: LeaderVote; nameOf: (id: string) => string }) {
  if (vote.status !== 'closed' && vote.status !== 'cancelled') return null;
  return (
    <section className="card stack" aria-label={t('votes.phase.closed')}>
      {vote.outcome ? <p>{t(`votes.outcome.${vote.outcome}`)}</p> : null}
      {vote.winnerUserId ? (
        <p>
          <strong>{t('votes.newLead', { name: nameOf(vote.winnerUserId) })}</strong>
        </p>
      ) : null}
      {vote.randomTieBreak ? <p className="muted">{t('votes.outcome.randomTieBreak')}</p> : null}
    </section>
  );
}

function RequestVote({ teamId }: { teamId: string }) {
  const status = useVoteRequests(teamId, true);
  const request = useRequestVote(teamId);
  return (
    <section className="card stack" aria-labelledby="vote-request-heading">
      <h2 id="vote-request-heading">{t('votes.request.title')}</h2>
      <p>{t('votes.request.none')}</p>
      {status.data ? (
        <p className="muted">
          {t('votes.request.lead', {
            required: status.data.required,
            requests: status.data.requests,
          })}
        </p>
      ) : null}
      {request.isSuccess ? <Alert tone="success">{t('votes.request.sent')}</Alert> : null}
      {request.isError ? <ActionErrorAlert error={request.error} /> : null}
      <div>
        <button
          type="button"
          className="button"
          disabled={request.isPending}
          onClick={() => request.mutate()}
        >
          {request.isPending ? t('votes.request.submitting') : t('votes.request.submit')}
        </button>
      </div>
    </section>
  );
}

function VoteView({ teamId, vote, team, meId }: Props & { vote: LeaderVote; team: Team }) {
  const nameOf = (userId: string) =>
    team.members.find((m) => m.userId === userId)?.displayName ?? t('votes.candidates.unknown');
  const members = team.members.filter((m) => m.status === 'active');
  return (
    <>
      <PhaseBanner vote={vote} />
      <Outcome vote={vote} nameOf={nameOf} />
      <CandidateList vote={vote} nameOf={nameOf} />
      <VoteActions teamId={teamId} vote={vote} meId={meId} members={members} nameOf={nameOf} />
    </>
  );
}

interface Props {
  teamId: string;
  meId: string;
}

function VoteBody({ teamId, meId }: Props) {
  const votes = useVotes(teamId);
  const team = useTeam(teamId);
  if (votes.isError || team.isError) {
    const error = votes.error ?? team.error;
    const hidden = error instanceof ApiError && (error.status === 403 || error.status === 404);
    return (
      <Alert tone="error">
        <p>{hidden ? t('votes.forbidden') : t('votes.loadFailed')}</p>
        {hidden ? null : (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              void votes.refetch();
              void team.refetch();
            }}
          >
            {t('votes.retry')}
          </button>
        )}
      </Alert>
    );
  }
  if (votes.isPending || team.isPending) return <p role="status">{t('votes.loading')}</p>;
  const vote = pickVote(votes.data);
  if (!vote) return <RequestVote teamId={teamId} />;
  return <VoteView teamId={teamId} vote={vote} team={team.data} meId={meId} />;
}

export function VotePage({ teamId }: { teamId: string }) {
  const me = useMe();
  useTeamChannel(teamId);
  return (
    <div className="stack">
      <h1>{t('votes.title')}</h1>
      <p>
        <Link href={`/teams/${teamId}`}>{t('votes.back')}</Link>
      </p>
      {me.data ? (
        <VoteBody teamId={teamId} meId={me.data.id} />
      ) : (
        <p role="status">{t('votes.loading')}</p>
      )}
    </div>
  );
}
