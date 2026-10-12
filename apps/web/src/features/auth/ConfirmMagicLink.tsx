'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api/client';
import { describeError } from '@/lib/api/error-message';
import { ApiError } from '@/lib/api/errors';
import { t } from '@/i18n';
import { safeRedirectPath } from './fragment';
import { TokenActionView, type TokenActionState } from './TokenActionView';
import { useFragmentToken } from './useFragmentToken';

/** A used or expired link cannot succeed on retry: only a new link helps. */
function isDefinitive(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'INVALID_TOKEN' || error.code === 'EXPIRED_TOKEN' || error.status === 400)
  );
}

/**
 * Completes a magic-link sign-in. The token comes from the URL fragment, leaves the address bar
 * at once and travels only in the body of a POST (never in a query string).
 */
export function ConfirmMagicLink() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (token: string) => {
      const { data } = await apiClient.POST('/auth/magic-link/confirm', { body: { token } });
      return safeRedirectPath(data?.redirectTo);
    },
    onSuccess: (target) => {
      queryClient.clear();
      router.replace(target);
    },
  });
  const token = useFragmentToken(mutation.mutate);

  let state: TokenActionState = 'pending';
  if (token === null) state = 'missing';
  else if (mutation.isError) state = 'error';
  else if (mutation.isSuccess) state = 'success';
  const canRetry = mutation.isError && !isDefinitive(mutation.error) && Boolean(token);

  return (
    <TokenActionView
      title={t('auth.confirm.title')}
      state={state}
      texts={{
        missing: t('auth.confirm.missing'),
        working: t('auth.confirm.working'),
        done: t('auth.confirm.done'),
      }}
      errorText={describeError(mutation.error)}
      retry={
        canRetry && token
          ? {
              label: t('auth.confirm.retry'),
              disabled: mutation.isPending,
              onClick: () => mutation.mutate(token),
            }
          : undefined
      }
      footer={
        state === 'missing' || state === 'error' ? (
          <Link className="button button-secondary" href="/sign-in">
            {t('auth.confirm.newLink')}
          </Link>
        ) : null
      }
    />
  );
}
