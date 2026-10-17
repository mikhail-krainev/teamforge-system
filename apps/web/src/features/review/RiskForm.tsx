'use client';

import { useId, useState, type FormEvent } from 'react';
import { Field } from '@/components/ui/Field';
import { t } from '@/i18n';

const REASON_MIN = 10;
const REASON_MAX = 2000;

interface Props {
  pointText: string;
  pending: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}

/** Lead only: the written reason for accepting a "no" answer as a risk (goes into the protocol). */
export function RiskForm({ pointText, pending, onSubmit, onCancel }: Props) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | undefined>();

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN) return setProblem(t('review.riskReasonShort'));
    setProblem(undefined);
    onSubmit(trimmed);
  }

  return (
    <form onSubmit={submit} noValidate className="card nested stack">
      <p>{t('review.riskFor', { text: pointText })}</p>
      <Field
        id={`${id}-reason`}
        label={t('review.riskReason')}
        hint={t('review.riskReasonHint')}
        error={problem}
        required
      >
        {(control) => (
          <textarea
            {...control}
            rows={3}
            maxLength={REASON_MAX}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </Field>
      <div className="row">
        <button type="submit" className="button" disabled={pending}>
          {pending ? t('review.riskConfirming') : t('review.riskConfirm')}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel}>
          {t('review.riskCancel')}
        </button>
      </div>
    </form>
  );
}
