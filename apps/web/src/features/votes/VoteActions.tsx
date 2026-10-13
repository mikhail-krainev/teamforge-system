'use client';

import { ActionErrorAlert } from '@/features/offers/ActionErrorAlert';
import { t } from '@/i18n';
import type { LeaderVote } from './api';
import { isVotable } from './model';
import { useVoteActions } from './useVoteActions';

type Actions = ReturnType<typeof useVoteActions>;

interface Member {
  userId: string;
  displayName: string;
}

interface SectionProps {
  vote: LeaderVote;
  meId: string;
  actions: Actions;
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: 'short', timeStyle: 'short' };

function dateText(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', DATE_FORMAT);
}

function Nomination({ vote, meId, actions, members }: SectionProps & { members: Member[] }) {
  const { busy } = actions;
  const mine = vote.candidates.find((c) => c.userId === meId);
  const others = members.filter(
    (m) => m.userId !== meId && !vote.candidates.some((c) => c.userId === m.userId),
  );
  return (
    <>
      {vote.canNominate ? (
        <div className="row">
          {mine === undefined ? (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => actions.nominateUser.mutate(meId)}
            >
              {t('votes.actions.nominateSelf')}
            </button>
          ) : null}
          {others.map((member) => (
            <button
              key={member.userId}
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => actions.nominateUser.mutate(member.userId)}
            >
              {t('votes.actions.nominateOther', { name: member.displayName })}
            </button>
          ))}
        </div>
      ) : null}
      {mine && !mine.confirmed && !mine.withdrawn ? (
        <div>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => actions.consentSelf.mutate(meId)}
          >
            {t('votes.actions.consent')}
          </button>
        </div>
      ) : null}
    </>
  );
}

function Ballot({ vote, actions, nameOf }: SectionProps & { nameOf: (id: string) => string }) {
  if (vote.myBallotCast) return <p role="status">{t('votes.actions.voted')}</p>;
  if (!vote.canVote) return <p className="muted">{t('votes.actions.cannotVote')}</p>;
  return (
    <ul className="stack">
      {vote.candidates.filter(isVotable).map((candidate) => (
        <li key={candidate.userId}>
          <button
            type="button"
            className="button"
            disabled={actions.busy}
            onClick={() => actions.ballot.mutate(candidate.userId)}
          >
            {t('votes.actions.voteFor', { name: nameOf(candidate.userId) })}
          </button>
        </li>
      ))}
    </ul>
  );
}

function OfferReply({ vote, meId, actions }: SectionProps) {
  const offer = vote.pendingOffer ?? null;
  if (!offer) return null;
  if (offer.userId !== meId) {
    return (
      <p className="muted">{t('votes.actions.offerOther', { date: dateText(offer.expiresAt) })}</p>
    );
  }
  return (
    <div className="stack">
      <p>{t('votes.actions.offerFor', { date: dateText(offer.expiresAt) })}</p>
      <div className="row">
        <button
          type="button"
          className="button"
          disabled={actions.busy}
          onClick={() => actions.respond.mutate(true)}
        >
          {t('votes.actions.acceptRole')}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={actions.busy}
          onClick={() => actions.respond.mutate(false)}
        >
          {t('votes.actions.declineRole')}
        </button>
      </div>
    </div>
  );
}

interface Props {
  teamId: string;
  vote: LeaderVote;
  meId: string;
  /** Active members of the team: the pool for nominations. */
  members: Member[];
  nameOf: (userId: string) => string;
}

/** Everything the signed-in member can do in the current phase. */
export function VoteActions({ teamId, vote, meId, members, nameOf }: Props) {
  const actions = useVoteActions(teamId, vote.id);
  const { status } = vote;
  const balloting = status === 'voting' || status === 'runoff';
  const offering = status === 'confirming' || status === 'offering';
  if (status !== 'nominating' && !balloting && !offering) return null;
  const mine = vote.candidates.find((c) => c.userId === meId);
  const section = { vote, meId, actions };
  return (
    <section className="stack" aria-labelledby="vote-actions-heading">
      <h2 id="vote-actions-heading">{t('votes.actions.title')}</h2>
      {actions.error ? <ActionErrorAlert error={actions.error} /> : null}
      {status === 'nominating' ? <Nomination {...section} members={members} /> : null}
      {balloting ? <Ballot {...section} nameOf={nameOf} /> : null}
      {offering ? <OfferReply {...section} /> : null}
      {mine && !mine.withdrawn && !offering ? (
        <div>
          <button
            type="button"
            className="button button-secondary"
            disabled={actions.busy}
            onClick={() => actions.withdrawSelf.mutate()}
          >
            {t('votes.actions.withdraw')}
          </button>
        </div>
      ) : null}
    </section>
  );
}
