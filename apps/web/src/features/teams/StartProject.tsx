'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { actionErrorText } from '@/features/offers/errors';
import { hasMessage, t } from '@/i18n';
import { ApiError } from '@/lib/api/errors';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { startProject, teamEventsKey, teamKey } from './api';

/** Start-specific texts for the 409 codes, so the lead knows why the project did not start. */
function startErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    const key = `teams.start.codes.${error.code}`;
    if (hasMessage(key)) return t(key);
  }
  return actionErrorText(error);
}

interface ConfirmProps {
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function StartConfirm({ pending, onConfirm, onCancel }: ConfirmProps) {
  return (
    <div className="card stack" role="group" aria-labelledby="team-start-confirm-title">
      <h3 id="team-start-confirm-title">{t('teams.start.confirmTitle')}</h3>
      <p>{t('teams.start.confirmText')}</p>
      <div className="row">
        <button type="button" className="button" disabled={pending} onClick={onConfirm}>
          {pending ? t('teams.start.starting') : t('teams.start.confirm')}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={pending}
          onClick={onCancel}
        >
          {t('teams.start.cancel')}
        </button>
      </div>
    </div>
  );
}

function useStart(teamId: string, onDone: () => void) {
  const queryClient = useQueryClient();
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: teamKey(teamId) }),
      queryClient.invalidateQueries({ queryKey: teamEventsKey(teamId) }),
      queryClient.invalidateQueries({ queryKey: ['teams', 'list'] }),
    ]);
  };
  return useIdempotentMutation({
    mutationFn: (_: void, key) => startProject(teamId, key),
    onSuccess: async () => {
      onDone();
      await refresh();
    },
    // A 409 means the team changed meanwhile: show its fresh status next to the message.
    onError: refresh,
  });
}

/** Lead-only: starts the project after an explicit confirmation (FR-TEAM-27). */
export function StartProject({ teamId }: { teamId: string }) {
  const [confirming, setConfirming] = useState(false);
  const start = useStart(teamId, () => setConfirming(false));
  return (
    <section className="stack" aria-labelledby="team-start-heading">
      <h2 id="team-start-heading">{t('teams.start.open')}</h2>
      {start.isError ? <Alert tone="error">{startErrorText(start.error)}</Alert> : null}
      {confirming ? (
        <StartConfirm
          pending={start.isPending}
          onConfirm={() => start.mutate()}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <div className="stack">
          <p className="muted">{t('teams.start.hint')}</p>
          <div>
            <button
              type="button"
              className="button"
              onClick={() => {
                start.reset();
                setConfirming(true);
              }}
            >
              {t('teams.start.open')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
