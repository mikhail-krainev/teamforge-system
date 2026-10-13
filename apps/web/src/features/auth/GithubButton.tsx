'use client';

import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';
import { describeError } from '@/lib/api/error-message';
import { t } from '@/i18n';
import { Alert } from '@/components/ui/Alert';

/** Only http(s) targets are followed; the URL comes from our own API but is checked anyway. */
export function isNavigableUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

export function GithubButton({ callbackPath }: { callbackPath: string }) {
  const mutation = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.POST('/auth/sign-in/social', {
        body: { provider: 'github', callbackURL: callbackPath },
      });
      if (!data || !isNavigableUrl(data.url)) throw new Error('Bad redirect');
      window.location.assign(data.url);
    },
  });
  const busy = mutation.isPending || mutation.isSuccess;
  return (
    <div className="stack">
      <button
        type="button"
        className="button button-block"
        disabled={busy}
        onClick={() => mutation.mutate()}
      >
        {busy ? t('auth.signIn.githubRedirecting') : t('auth.signIn.github')}
      </button>
      {mutation.isError ? <Alert tone="error">{describeError(mutation.error)}</Alert> : null}
    </div>
  );
}
