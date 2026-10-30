'use client';

import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { Alert } from '@/components/ui/Alert';
import { t } from '@/i18n';
import type { FraudDecisionValue } from './api';

interface Props {
  decision: FraudDecisionValue;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Focus moves into the dialog, Tab stays inside it, Escape cancels (unless a send is running). */
function useFocusTrap(pending: boolean, onCancel: () => void) {
  const root = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => opener?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !pending) return onCancel();
    if (event.key !== 'Tab') return;
    const controls = root.current?.querySelectorAll<HTMLElement>('button:not(:disabled)');
    if (!controls || controls.length === 0) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  return { root, cancel, onKeyDown };
}

/** Modal confirmation of a final decision. */
export function ConfirmDialog({ decision, pending, error, onConfirm, onCancel }: Props) {
  const id = useId();
  const { root, cancel, onKeyDown } = useFocusTrap(pending, onCancel);

  return (
    <div className="modal-backdrop">
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-text`}
        className="card stack modal"
        onKeyDown={onKeyDown}
      >
        <h2 id={`${id}-title`}>{t('fraud.confirm.title')}</h2>
        <p id={`${id}-text`}>
          {decision === 'ok' ? t('fraud.confirm.okText') : t('fraud.confirm.violationText')}
        </p>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="row">
          <button type="button" className="button" disabled={pending} onClick={onConfirm}>
            {pending ? t('fraud.confirm.pending') : t('fraud.confirm.confirm')}
          </button>
          <button
            ref={cancel}
            type="button"
            className="button button-secondary"
            disabled={pending}
            onClick={onCancel}
          >
            {t('fraud.confirm.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
