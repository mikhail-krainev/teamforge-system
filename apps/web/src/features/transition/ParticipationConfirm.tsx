'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { hasMessage, t } from '@/i18n';
import { ApiError } from '@/lib/api/errors';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import type { Member } from '@/features/teams/api';
import { confirmParticipation } from './api';

function participationError(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    const key = `transition.participation.errors.${error.code}`;
    if (hasMessage(key)) return t(key);
  }
  return t('transition.participation.errors.unknown');
}

interface Props {
  teamId: string;
  stageOrdinal: number;
  members: readonly Member[];
}

/** Lead only (FR-WORK-11): confirms that a member took part in the stage even without a contribution. */
export function ParticipationConfirm({ teamId, stageOrdinal, members }: Props) {
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  const confirm = useIdempotentMutation({
    mutationFn: (userId: string, key) =>
      confirmParticipation(teamId, { userId, stageOrdinal }, key),
    onSuccess: (result) => setConfirmed((previous) => new Set(previous).add(result.userId)),
  });
  const active = members.filter((member) => member.status === 'active');

  return (
    <section className="stack" aria-labelledby={`participation-${stageOrdinal}`}>
      <h2 id={`participation-${stageOrdinal}`}>{t('transition.participation.heading')}</h2>
      <p className="muted">{t('transition.participation.hint')}</p>
      {confirm.isError ? <Alert tone="error">{participationError(confirm.error)}</Alert> : null}
      <ul className="stack">
        {active.map((member) => (
          <li key={member.userId}>
            {confirmed.has(member.userId) ? (
              <span>{t('transition.participation.confirmed', { name: member.displayName })}</span>
            ) : (
              <button
                type="button"
                className="button button-secondary"
                disabled={confirm.isPending}
                onClick={() => confirm.mutate(member.userId)}
              >
                {t('transition.participation.confirm', { name: member.displayName })}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
