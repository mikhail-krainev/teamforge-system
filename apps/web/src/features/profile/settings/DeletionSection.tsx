'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { apiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { describeError } from '@/lib/api/error-message';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { t } from '@/i18n';
import { useMarkAccountDeleting, useMe } from '@/features/auth/session';

/** `requestDeletion` with an explicit confirmation (FR-AUTH-09). */
function useDeletionRequest(onRequested: (scheduledAt: string) => void) {
  return useIdempotentMutation({
    mutationFn: async (_: void, key) => {
      const { data } = await apiClient.POST('/v1/me/deletion-requests', {
        body: { reason: 'user_request', confirm: true },
        params: { header: { 'Idempotency-Key': key } },
      });
      if (!data) throw new Error('Empty deletion response');
      return data;
    },
    onSuccess: (data) => onRequested(data.scheduledAt),
  });
}

function Requested({ scheduledAt }: { scheduledAt: string | null }) {
  return (
    <Alert tone="success">
      <h2>{t('profile.settings.deletion.requestedTitle')}</h2>
      <p>
        {scheduledAt
          ? t('profile.settings.deletion.requestedBody', {
              scheduledAt: new Date(scheduledAt).toLocaleString('ru-RU'),
            })
          : t('profile.settings.deletion.requestedNoDate')}
      </p>
    </Alert>
  );
}

export function DeletionSection() {
  const [asking, setAsking] = useState(false);
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);
  const me = useMe();
  const markDeleting = useMarkAccountDeleting();
  const request = useDeletionRequest((at) => {
    setScheduledAt(at);
    markDeleting();
  });

  // The account state decides, not the local click: a reload or a second tab shows the same.
  if (scheduledAt !== null || me.data?.status === 'deleting') {
    return <Requested scheduledAt={scheduledAt} />;
  }
  return (
    <section className="card stack" aria-labelledby="deletion-heading">
      <h2 id="deletion-heading">{t('profile.settings.deletion.title')}</h2>
      <p>{t('profile.settings.deletion.lead')}</p>
      {asking ? (
        <DeletionConfirm
          pending={request.isPending}
          error={request.error}
          onConfirm={() => request.mutate()}
          onCancel={() => setAsking(false)}
        />
      ) : (
        <div>
          <button type="button" className="button button-danger" onClick={() => setAsking(true)}>
            {t('profile.settings.deletion.open')}
          </button>
        </div>
      )}
    </section>
  );
}

interface ConfirmProps {
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeletionConfirm({ pending, error, onConfirm, onCancel }: ConfirmProps) {
  const [confirmed, setConfirmed] = useState(false);
  const [missed, setMissed] = useState(false);
  const reauth = error instanceof ApiError && error.code === 'REAUTH_REQUIRED';
  return (
    <div className="stack">
      <h3>{t('profile.settings.deletion.confirmTitle')}</h3>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={confirmed}
          aria-invalid={missed && !confirmed ? true : undefined}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        {t('profile.settings.deletion.confirmCheck')}
      </label>
      {missed && !confirmed ? (
        <p className="field-error" role="alert">
          {t('profile.settings.deletion.needConfirm')}
        </p>
      ) : null}
      {error ? (
        <Alert tone="error">
          {reauth ? t('profile.settings.deletion.reauth') : describeError(error)}
        </Alert>
      ) : null}
      <div className="row">
        <button
          type="button"
          className="button button-danger"
          disabled={pending}
          onClick={() => (confirmed ? onConfirm() : setMissed(true))}
        >
          {pending
            ? t('profile.settings.deletion.confirming')
            : t('profile.settings.deletion.confirm')}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={pending}
          onClick={onCancel}
        >
          {t('profile.settings.deletion.cancel')}
        </button>
      </div>
    </div>
  );
}
