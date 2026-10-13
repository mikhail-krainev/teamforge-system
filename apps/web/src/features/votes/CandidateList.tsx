import { t } from '@/i18n';
import type { LeaderVote } from './api';

interface Props {
  vote: LeaderVote;
  nameOf: (userId: string) => string;
}

/**
 * Candidates and their state. Vote counts exist only after the vote is closed (FR-TEAM-21): the
 * API leaves `votes` empty before that, and the page shows them only for a closed vote. Who voted
 * for whom is not in the contract and is never shown.
 */
export function CandidateList({ vote, nameOf }: Props) {
  const showVotes = vote.status === 'closed';
  return (
    <section className="stack" aria-labelledby="vote-candidates-heading">
      <h2 id="vote-candidates-heading">{t('votes.candidates.title')}</h2>
      {vote.candidates.length === 0 ? (
        <p className="muted">{t('votes.candidates.empty')}</p>
      ) : (
        <ul className="stack">
          {vote.candidates.map((candidate) => {
            const state = candidate.withdrawn
              ? 'withdrawn'
              : candidate.confirmed
                ? 'confirmed'
                : 'pending';
            return (
              <li key={candidate.userId} className="card nested">
                <p>
                  <strong>{nameOf(candidate.userId)}</strong>
                </p>
                <p className="muted">
                  {t(`votes.candidates.${state}`)}
                  {showVotes && typeof candidate.votes === 'number'
                    ? ` · ${t('votes.candidates.votes', { count: candidate.votes })}`
                    : ''}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
