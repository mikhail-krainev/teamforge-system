'use client';

import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Field } from '@/components/ui/Field';
import { apiClient } from '@/lib/api/client';
import { describeError, invalidFields, isRateLimited, retryAfterOf } from '@/lib/api/error-message';
import { t } from '@/i18n';
import { useCountdown } from './useCountdown';

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;
const DEFAULT_WAIT_SECONDS = 60;

/** `signInMagicLink` plus the wait that follows a 429 (taken from `Retry-After`). */
function useMagicLinkRequest(callbackPath: string) {
  const countdown = useCountdown();
  const mutation = useMutation({
    mutationFn: async (email: string) => {
      await apiClient.POST('/auth/sign-in/magic-link', {
        body: { email, callbackURL: callbackPath },
      });
      return email;
    },
    onError: (error) => {
      if (isRateLimited(error)) countdown.start(retryAfterOf(error) ?? DEFAULT_WAIT_SECONDS);
    },
  });
  return { mutation, waitSeconds: countdown.remaining };
}

export function MagicLinkForm({ callbackPath }: { callbackPath: string }) {
  const [email, setEmail] = useState('');
  const [localError, setLocalError] = useState<string | undefined>();
  const { mutation, waitSeconds } = useMagicLinkRequest(callbackPath);

  function submit(event: FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!EMAIL_SHAPE.test(address) || address.length > EMAIL_MAX) {
      setLocalError(t('auth.signIn.emailInvalid'));
      return;
    }
    setLocalError(undefined);
    mutation.mutate(address);
  }

  if (mutation.isSuccess) {
    return <SentNotice address={mutation.data} onReset={() => mutation.reset()} />;
  }
  const serverRejected = mutation.isError && invalidFields(mutation.error).has('email');
  const fieldError = localError ?? (serverRejected ? t('auth.signIn.emailInvalid') : undefined);
  return (
    <form onSubmit={submit} noValidate className="stack">
      <EmailField value={email} onChange={setEmail} error={fieldError} />
      {mutation.isError && !serverRejected ? (
        <Alert tone="error">{describeError(mutation.error)}</Alert>
      ) : null}
      <button
        type="submit"
        className="button button-secondary button-block"
        disabled={mutation.isPending || waitSeconds > 0}
      >
        {mutation.isPending ? t('auth.signIn.submitting') : t('auth.signIn.submit')}
      </button>
      <p className="muted mono" role="status" aria-live="polite">
        {waitSeconds > 0 ? t('auth.signIn.wait', { seconds: waitSeconds }) : ''}
      </p>
    </form>
  );
}

function SentNotice({ address, onReset }: { address: string; onReset: () => void }) {
  return (
    <div className="stack">
      <Alert tone="success">
        <h2>{t('auth.signIn.sentTitle')}</h2>
        <p>{t('auth.signIn.sentBody', { email: address })}</p>
      </Alert>
      <button type="button" className="button button-secondary" onClick={onReset}>
        {t('auth.signIn.sentOther')}
      </button>
    </div>
  );
}

interface EmailFieldProps {
  value: string;
  onChange: (value: string) => void;
  error: string | undefined;
}

function EmailField({ value, onChange, error }: EmailFieldProps) {
  return (
    <Field
      id="sign-in-email"
      label={t('auth.signIn.emailLabel')}
      hint={t('auth.signIn.emailHint')}
      error={error}
      required
    >
      {(control) => (
        <input
          {...control}
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}
