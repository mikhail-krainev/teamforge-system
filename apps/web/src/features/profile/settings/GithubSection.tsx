'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert } from '@/components/ui/Alert';
import { apiClient } from '@/lib/api/client';
import { describeError } from '@/lib/api/error-message';
import { t } from '@/i18n';
import { isNavigableUrl } from '@/features/auth/GithubButton';

/** `getMyGithubAccount` + `linkGithub`: the GitHub connection is needed to join teams (FR-AUTH-05). */
export function GithubSection() {
  const status = useQuery({
    queryKey: ['github', 'me'],
    queryFn: async () => (await apiClient.GET('/v1/me/github')).data,
  });
  const link = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.POST('/auth/link-social', {
        body: { provider: 'github', callbackURL: '/settings' },
      });
      if (!data || !isNavigableUrl(data.url)) throw new Error('Bad redirect');
      window.location.assign(data.url);
    },
  });
  const account = status.data;
  const busy = link.isPending || link.isSuccess;
  return (
    <section className="card stack" aria-labelledby="github-heading">
      <h2 id="github-heading">{t('profile.settings.github.title')}</h2>
      {status.isError ? (
        <Alert tone="error">{t('profile.settings.github.loadFailed')}</Alert>
      ) : null}
      {status.isPending ? <p role="status">{t('auth.session.loading')}</p> : null}
      {account?.linked ? (
        <p>
          {account.login
            ? t('profile.settings.github.linked', { login: account.login })
            : t('profile.settings.github.linkedNoLogin')}
        </p>
      ) : null}
      {account && !account.linked ? (
        <>
          <p>{t('profile.settings.github.notLinked')}</p>
          {link.isError ? <Alert tone="error">{describeError(link.error)}</Alert> : null}
          <div>
            <button type="button" className="button" disabled={busy} onClick={() => link.mutate()}>
              {busy ? t('profile.settings.github.linking') : t('profile.settings.github.link')}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
