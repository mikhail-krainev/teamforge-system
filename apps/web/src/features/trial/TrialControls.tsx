'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { MatchingErrorAlert } from '@/features/matching/MatchingErrorAlert';
import { teamEventsKey, teamKey, type Member } from '@/features/teams/api';
import { t } from '@/i18n';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { confirmTrial, excludeTrialMember } from './api';

/** Badge shown to everyone who sees the roster. */
export function TrialBadge({ member }: { member: Pick<Member, 'trialUntil'> }) {
  if (!member.trialUntil) return null;
  return (
    <span className="tag">
      {t('matching.trial.badge', {
        date: new Date(member.trialUntil).toLocaleDateString('ru-RU'),
      })}
    </span>
  );
}

function useTrialActions(teamId: string, userId: string) {
  const queryClient = useQueryClient();
  // Also after a 409 (expired, confirmed elsewhere): the roster shows the real state.
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: teamKey(teamId) }),
      queryClient.invalidateQueries({ queryKey: teamEventsKey(teamId) }),
      queryClient.invalidateQueries({ queryKey: ['recommendations'] }),
      queryClient.invalidateQueries({ queryKey: ['demand'] }),
    ]);
  };
  const confirm = useIdempotentMutation({
    mutationFn: (_: void, key) => confirmTrial(teamId, userId, key),
    onSuccess: refresh,
    onError: refresh,
  });
  const exclude = useIdempotentMutation({
    mutationFn: (_: void, key) => excludeTrialMember(teamId, userId, key),
    onSuccess: refresh,
    onError: refresh,
  });
  return { confirm, exclude };
}

interface ExcludeConfirmProps {
  name: string;
  pending: boolean;
  onYes: () => void;
  onNo: () => void;
}

function ExcludeConfirm({ name, pending, onYes, onNo }: ExcludeConfirmProps) {
  return (
    <div className="card stack" role="group" aria-labelledby="trial-exclude-title">
      <h4 id="trial-exclude-title">{t('matching.trial.excludeTitle', { name })}</h4>
      <p>{t('matching.trial.excludeText')}</p>
      <div className="row">
        <button type="button" className="button button-danger" disabled={pending} onClick={onYes}>
          {pending ? t('matching.trial.excluding') : t('matching.trial.excludeYes')}
        </button>
        <button type="button" className="button button-secondary" disabled={pending} onClick={onNo}>
          {t('matching.trial.excludeNo')}
        </button>
      </div>
    </div>
  );
}

/** The lead's "Подтвердить" / "Исключить" for one member on trial (exclusion asks for confirmation). */
export function TrialControls({ teamId, member }: { teamId: string; member: Member }) {
  const { confirm, exclude } = useTrialActions(teamId, member.userId);
  const [asking, setAsking] = useState(false);
  const busy = confirm.isPending || exclude.isPending;
  const error = confirm.error ?? exclude.error;
  if (confirm.isSuccess) return <Alert tone="success">{t('matching.trial.confirmed')}</Alert>;
  if (exclude.isSuccess) return <Alert tone="success">{t('matching.trial.excluded')}</Alert>;
  return (
    <div className="stack">
      {error ? <MatchingErrorAlert error={error} /> : null}
      {asking ? (
        <ExcludeConfirm
          name={member.displayName}
          pending={exclude.isPending}
          onYes={() => exclude.mutate()}
          onNo={() => setAsking(false)}
        />
      ) : (
        <div className="row">
          <button
            type="button"
            className="button"
            disabled={busy}
            aria-label={t('matching.trial.confirmAria', { name: member.displayName })}
            onClick={() => confirm.mutate()}
          >
            {confirm.isPending ? t('matching.trial.confirming') : t('matching.trial.confirm')}
          </button>
          <button
            type="button"
            className="button button-danger"
            disabled={busy}
            aria-label={t('matching.trial.excludeAria', { name: member.displayName })}
            onClick={() => {
              exclude.reset();
              setAsking(true);
            }}
          >
            {t('matching.trial.exclude')}
          </button>
        </div>
      )}
    </div>
  );
}
