import type { ReactNode } from 'react';
import { Alert } from '@/components/ui/Alert';

export type TokenActionState = 'missing' | 'pending' | 'success' | 'error';

interface Props {
  title: string;
  state: TokenActionState;
  texts: { missing: string; working: string; done: string };
  /** Already user-facing text of the failure (used in the `error` state). */
  errorText?: string;
  /** Offered only when a retry can help; absent for used or expired tokens. */
  retry?: { label: string; disabled: boolean; onClick: () => void };
  footer?: ReactNode;
}

/** Shared look of the pages that spend a one-time fragment token (magic link, deletion cancel). */
export function TokenActionView({ title, state, texts, errorText, retry, footer }: Props) {
  return (
    <div className="page-narrow">
      <h1>{title}</h1>
      <div className="card stack" aria-live="polite">
        {state === 'missing' ? <Alert tone="error">{texts.missing}</Alert> : null}
        {state === 'error' ? <Alert tone="error">{errorText}</Alert> : null}
        {state === 'success' ? <Alert tone="success">{texts.done}</Alert> : null}
        {state === 'pending' ? (
          <p role="status">
            <span className="spinner" aria-hidden="true" /> {texts.working}
          </p>
        ) : null}
        {retry ? (
          <button
            type="button"
            className="button"
            disabled={retry.disabled}
            onClick={retry.onClick}
          >
            {retry.label}
          </button>
        ) : null}
        {footer}
      </div>
    </div>
  );
}
