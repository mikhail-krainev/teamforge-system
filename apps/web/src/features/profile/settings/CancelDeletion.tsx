'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { apiClient } from '@/lib/api/client';
import { describeError } from '@/lib/api/error-message';
import { ApiError } from '@/lib/api/errors';
import { TokenActionView, type TokenActionState } from '@/features/auth/TokenActionView';
import { useFragmentToken } from '@/features/auth/useFragmentToken';
import { t } from '@/i18n';

/**
 * Landing page of the cancellation link from the deletion email (`#token=...`). It works without
 * a session: the one-time token is the credential, and it is sent only in the POST body.
 */
export function CancelDeletion() {
  const cancel = useMutation({
    mutationFn: async (token: string) => {
      await apiClient.POST('/v1/deletion-request-cancellations', { body: { token } });
    },
  });
  const token = useFragmentToken(cancel.mutate);
  const gone = cancel.error instanceof ApiError && cancel.error.status === 410;

  let state: TokenActionState = 'pending';
  if (token === null) state = 'missing';
  else if (cancel.isError) state = 'error';
  else if (cancel.isSuccess) state = 'success';

  return (
    <TokenActionView
      title={t('profile.cancelDeletion.title')}
      state={state}
      texts={{
        missing: t('profile.cancelDeletion.missing'),
        working: t('profile.cancelDeletion.working'),
        done: t('profile.cancelDeletion.done'),
      }}
      errorText={gone ? t('profile.cancelDeletion.gone') : describeError(cancel.error)}
      retry={
        cancel.isError && !gone && token
          ? {
              label: t('profile.cancelDeletion.retry'),
              disabled: cancel.isPending,
              onClick: () => cancel.mutate(token),
            }
          : undefined
      }
      footer={
        state === 'success' || gone ? (
          <Link className="button button-secondary" href="/sign-in">
            {t('profile.cancelDeletion.signIn')}
          </Link>
        ) : null
      }
    />
  );
}
