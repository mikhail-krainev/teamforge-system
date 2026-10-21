'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Field } from '@/components/ui/Field';
import { t } from '@/i18n';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { creditKey, fileDispute } from './api';
import { disputeErrorText, MAX_DISPUTE_LENGTH, validateDispute } from './model';

function useDispute(teamId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    mutationFn: (text: string, key) => fileDispute(teamId, text, key),
    onSettled: () => queryClient.invalidateQueries({ queryKey: creditKey(teamId) }),
  });
}

function DisputeText({
  id,
  value,
  error,
  areaRef,
  onChange,
}: {
  id: string;
  value: string;
  error: string | null;
  areaRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
}) {
  return (
    <Field
      id={id}
      label={t('rewards.dispute.textLabel')}
      hint={t('rewards.dispute.hint')}
      error={error ?? undefined}
      required
    >
      {(control) => (
        <textarea
          {...control}
          ref={areaRef}
          rows={5}
          maxLength={MAX_DISPUTE_LENGTH}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

type DisputeMutation = ReturnType<typeof useDispute>;

function DisputeFields({
  mutation,
  onCancel,
}: {
  mutation: DisputeMutation;
  onCancel: () => void;
}) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);

  useEffect(() => area.current?.focus(), []);

  function submit(event: FormEvent) {
    event.preventDefault();
    const problem = validateDispute(text);
    setInvalid(problem);
    if (problem) {
      area.current?.focus();
      return;
    }
    mutation.mutate(text.trim());
  }

  return (
    <form className="card stack" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
      <h3 id={`${id}-title`}>{t('rewards.dispute.title')}</h3>
      <DisputeText
        id={`${id}-text`}
        value={text}
        error={invalid}
        areaRef={area}
        onChange={setText}
      />
      {mutation.isError ? <Alert tone="error">{disputeErrorText(mutation.error)}</Alert> : null}
      <div className="row">
        <button type="submit" className="button" disabled={mutation.isPending}>
          {mutation.isPending ? t('rewards.dispute.sending') : t('rewards.dispute.submit')}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel}>
          {t('rewards.dispute.cancel')}
        </button>
      </div>
    </form>
  );
}

/** "Оспорить проект": a complaint is possible only in the cooling window, once (FR-REW-11). */
export function DisputeSection({ teamId }: { teamId: string }) {
  const [open, setOpen] = useState(false);
  const mutation = useDispute(teamId);

  if (mutation.isSuccess) return <Alert tone="success">{t('rewards.dispute.sent')}</Alert>;
  if (!open) {
    return (
      <div>
        <button type="button" className="button button-secondary" onClick={() => setOpen(true)}>
          {t('rewards.dispute.open')}
        </button>
      </div>
    );
  }
  return <DisputeFields mutation={mutation} onCancel={() => setOpen(false)} />;
}
