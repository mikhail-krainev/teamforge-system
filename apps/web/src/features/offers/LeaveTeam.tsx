'use client';

import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { t } from '@/i18n';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { leaveTeam } from './api';
import { ActionErrorAlert } from './ActionErrorAlert';

interface ConfirmProps {
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function LeaveConfirm({ pending, onConfirm, onCancel }: ConfirmProps) {
  return (
    <div className="card stack" role="group" aria-labelledby="leave-confirm-title">
      <h3 id="leave-confirm-title">{t('offers.leave.confirmTitle')}</h3>
      <p>{t('offers.leave.confirmText')}</p>
      <div className="row">
        <button
          type="button"
          className="button button-danger"
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? t('offers.leave.leaving') : t('offers.leave.confirm')}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={pending}
          onClick={onCancel}
        >
          {t('offers.leave.cancel')}
        </button>
      </div>
    </div>
  );
}

/** The confirmation shown after leaving, with a way out of the team page. */
export function LeftNotice() {
  return (
    <Alert tone="success">
      {t('offers.leave.done')} <Link href="/teams">{t('offers.leave.toTeams')}</Link>
    </Alert>
  );
}

/**
 * Leave the team after an explicit confirmation; an inconclusive failure is retried with the same key.
 * `onLeft` lets the parent keep the confirmation: once the roster refetch (realtime event) shows the
 * user is no longer a member, this component is unmounted and its own success state would be lost.
 */
export function LeaveTeam({ teamId, onLeft }: { teamId: string; onLeft?: () => void }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const leave = useIdempotentMutation({
    mutationFn: (_: void, key) => leaveTeam(teamId, key),
    onSuccess: async () => {
      setConfirming(false);
      onLeft?.();
      // The detail query is left alone: after leaving, a refetch may be refused and would hide the message.
      await queryClient.invalidateQueries({ queryKey: ['teams', 'list'] });
    },
  });
  if (leave.isSuccess) {
    return <LeftNotice />;
  }
  const ask = () => {
    leave.reset();
    setConfirming(true);
  };
  return (
    <section className="stack" aria-label={t('offers.leave.open')}>
      {leave.isError ? <ActionErrorAlert error={leave.error} /> : null}
      {confirming ? (
        <LeaveConfirm
          pending={leave.isPending}
          onConfirm={() => leave.mutate()}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <div>
          <button type="button" className="button button-danger" onClick={ask}>
            {t('offers.leave.open')}
          </button>
        </div>
      )}
    </section>
  );
}
