'use client';

import { useEffect, useState } from 'react';
import { t } from '@/i18n';
import type { LeaderVote } from './api';
import { formatRemaining, isActive } from './model';

const TICK_MS = 30_000;

/** Current time, refreshed every 30 s (the countdown shows minutes, not seconds). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Countdown({ deadline }: { deadline: string }) {
  const now = useNow();
  const left = formatRemaining(new Date(deadline).getTime() - now);
  // Outside the live region: a ticking text must not be announced every half minute.
  return <p>{left ? t('votes.deadline', { left }) : t('votes.deadlinePassed')}</p>;
}

/**
 * The phase is the only part announced to screen readers (`role="status"`, polite): a change of
 * phase replaces the text inside it. The countdown and turnout stay outside the live region.
 */
export function PhaseBanner({ vote }: { vote: LeaderVote }) {
  const active = isActive(vote);
  return (
    <section className="card stack" aria-labelledby="vote-phase-heading">
      <h2 id="vote-phase-heading" className="sr-only">
        {t('votes.phase.label')}
      </h2>
      <div role="status" aria-live="polite" aria-label={t('votes.phase.label')} className="stack">
        <p>
          <strong>{t(`votes.phase.${vote.status}`)}</strong>
        </p>
        <p className="muted">{t(`votes.hint.${vote.status}`)}</p>
      </div>
      <p className="muted">{t(`votes.trigger.${vote.trigger}`)}</p>
      {active && vote.phaseDeadline ? <Countdown deadline={vote.phaseDeadline} /> : null}
      {active && vote.extended ? <p className="muted">{t('votes.extended')}</p> : null}
      {active && (vote.status === 'voting' || vote.status === 'runoff') ? (
        <p className="muted">
          {t('votes.turnout', {
            cast: vote.ballotsCast,
            eligible: vote.eligibleCount,
            quorum: vote.quorum,
          })}
        </p>
      ) : null}
    </section>
  );
}
