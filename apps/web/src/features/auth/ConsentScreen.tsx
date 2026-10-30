'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@/components/ui/Alert';
import { LoadingState } from '@/components/ui/LoadingState';
import { apiClient } from '@/lib/api/client';
import { describeError } from '@/lib/api/error-message';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { t } from '@/i18n';
import { ME_QUERY_KEY } from './session';
import { useSignOut } from './useSignOut';

function useConsent() {
  const queryClient = useQueryClient();
  const text = useQuery({
    queryKey: ['consent', 'current'],
    queryFn: async () => (await apiClient.GET('/v1/consent/current')).data,
  });
  const accept = useIdempotentMutation({
    mutationFn: async (_: void, key) => {
      const current = text.data;
      if (!current) throw new Error('Consent text is not loaded');
      await apiClient.POST('/v1/me/consents', {
        body: { version: current.version, textHash: current.textHash },
        params: { header: { 'Idempotency-Key': key } },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
  });
  return { text, accept };
}

/** Full-page consent step (FR-AUTH-03): nothing else is rendered until it is accepted. */
export function ConsentScreen() {
  const signOut = useSignOut();
  const { text, accept } = useConsent();
  return (
    <div className="page-narrow">
      <header className="page-head">
        <h1>{t('auth.consent.title')}</h1>
        <div className="page-aside">
          <p className="lead">{t('auth.consent.lead')}</p>
        </div>
      </header>
      <section className="card stack" aria-labelledby="consent-text-heading">
        <ConsentBody
          data={text.data}
          failed={text.isError}
          onRetry={() => void text.refetch()}
          headingId="consent-text-heading"
        />
        {accept.isError ? <Alert tone="error">{describeError(accept.error)}</Alert> : null}
        <div className="row">
          <button
            type="button"
            className="button"
            disabled={!text.data || accept.isPending}
            onClick={() => accept.mutate()}
          >
            {accept.isPending ? t('auth.consent.accepting') : t('auth.consent.accept')}
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            {t('auth.consent.decline')}
          </button>
        </div>
        <p className="muted">{t('auth.consent.declineHint')}</p>
      </section>
    </div>
  );
}

interface BodyProps {
  data: { version: string; text: string } | undefined;
  failed: boolean;
  onRetry: () => void;
  headingId: string;
}

function ConsentBody({ data, failed, onRetry, headingId }: BodyProps) {
  if (failed) {
    return (
      <Alert tone="error">
        <p>{t('auth.consent.loadFailed')}</p>
        <button type="button" className="button button-secondary" onClick={onRetry}>
          {t('auth.consent.retry')}
        </button>
      </Alert>
    );
  }
  if (!data) return <LoadingState text={t('auth.consent.loading')} />;
  return (
    <>
      <h2 id={headingId}>{t('auth.consent.textLabel')}</h2>
      <p className="muted">{t('auth.consent.version', { version: data.version })}</p>
      {/* A scrollable region must be focusable so keyboard users can read the whole text. */}
      <div className="consent-text" tabIndex={0} role="region" aria-labelledby={headingId}>
        {data.text}
      </div>
    </>
  );
}
