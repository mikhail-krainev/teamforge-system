'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { feedRootKey } from '@/features/contribution/api';
import { workspaceKey } from '@/features/route/api';
import { teamEventsKey, teamKey } from '@/features/teams/api';
import { t } from '@/i18n';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { completeProject, completionKey } from './api';
import { finishErrorText, unmetFromError, unmetText } from './model';

function useFinish(teamId: string) {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: workspaceKey(teamId) }),
      queryClient.invalidateQueries({ queryKey: teamKey(teamId) }),
      queryClient.invalidateQueries({ queryKey: teamEventsKey(teamId) }),
      queryClient.invalidateQueries({ queryKey: feedRootKey(teamId) }),
    ]);
  return useIdempotentMutation({
    mutationFn: (_: void, key) => completeProject(teamId, key),
    onSuccess: async (completion) => {
      queryClient.setQueryData(completionKey(teamId), completion);
      await refresh();
    },
    // Whatever the refusal, the picture of the project may have moved on: read it again.
    onError: () => refresh(),
  });
}

function Blocked({ unmet }: { unmet: { code: string; message?: string | undefined }[] }) {
  return (
    <Alert tone="error">
      <p>
        <strong>{t('completion.finish.blocked')}</strong>
      </p>
      <ul className="stack" aria-label={t('completion.finish.blockedList')}>
        {unmet.map((entry) => (
          <li key={entry.code}>{unmetText(entry)}</li>
        ))}
      </ul>
    </Alert>
  );
}

function ConfirmBox({
  titleId,
  pending,
  done,
  onConfirm,
  onCancel,
}: {
  titleId: string;
  pending: boolean;
  done: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="card stack" role="group" aria-labelledby={titleId}>
      <h3 id={titleId}>{t('completion.finish.confirmTitle')}</h3>
      <p>{t('completion.finish.confirmText')}</p>
      <div className="row">
        <button type="button" className="button" disabled={pending || done} onClick={onConfirm}>
          {pending ? t('completion.finish.confirming') : t('completion.finish.confirm')}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={pending || done}
          onClick={onCancel}
        >
          {t('completion.finish.cancel')}
        </button>
      </div>
    </div>
  );
}

/** "Завершить проект" with a confirmation; enabled only for a green, still valid check (lead only). */
export function FinishPanel({ teamId, enabled }: { teamId: string; enabled: boolean }) {
  const titleId = useId();
  const [confirming, setConfirming] = useState(false);
  const mutation = useFinish(teamId);
  const unmet = mutation.isError ? unmetFromError(mutation.error) : null;
  const failure = mutation.isError && !unmet ? finishErrorText(mutation.error) : null;
  return (
    <div className="stack">
      {unmet ? <Blocked unmet={unmet} /> : null}
      {failure ? <Alert tone="error">{failure}</Alert> : null}
      {confirming ? (
        <ConfirmBox
          titleId={titleId}
          pending={mutation.isPending}
          done={mutation.isSuccess}
          onConfirm={() => mutation.mutate()}
          onCancel={() => {
            mutation.reset();
            setConfirming(false);
          }}
        />
      ) : (
        <div>
          <button
            type="button"
            className="button"
            disabled={!enabled}
            aria-describedby={enabled ? undefined : `${titleId}-hint`}
            onClick={() => setConfirming(true)}
          >
            {t('completion.finish.button')}
          </button>
          {enabled ? null : (
            <p id={`${titleId}-hint`} className="muted">
              {t('completion.finish.disabledHint')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
