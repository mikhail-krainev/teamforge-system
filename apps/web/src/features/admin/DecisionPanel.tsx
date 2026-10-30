'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { Field } from '@/components/ui/Field';
import { hasMessage, t } from '@/i18n';
import { describeError } from '@/lib/api/error-message';
import { ApiError } from '@/lib/api/errors';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { caseKey, casesRootKey, decideCase, type FraudCase, type FraudDecisionValue } from './api';
import { ConfirmDialog } from './ConfirmDialog';

const MIN_COMMENT = 10;
const MAX_COMMENT = 4000;

function commentProblem(comment: string): string | null {
  const length = comment.trim().length;
  if (length < MIN_COMMENT) return t('fraud.decision.errors.short');
  return length > MAX_COMMENT ? t('fraud.decision.errors.long') : null;
}

function decisionErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    const key = `fraud.decision.errors.codes.${error.code}`;
    if (hasMessage(key)) return t(key);
  }
  return describeError(error);
}

function useDecision(caseId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    mutationFn: (input: { decision: FraudDecisionValue; comment: string }, key) =>
      decideCase(caseId, input, key),
    onSuccess: (decided) => queryClient.setQueryData(caseKey(caseId), decided),
    // Whatever the refusal, the case may have moved on: read the queue and the card again.
    onSettled: () => queryClient.invalidateQueries({ queryKey: casesRootKey }),
  });
}

function CommentField({
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
      label={t('fraud.decision.comment')}
      hint={t('fraud.decision.commentHint')}
      error={error ?? undefined}
      required
    >
      {(control) => (
        <textarea
          {...control}
          ref={areaRef}
          rows={4}
          maxLength={MAX_COMMENT}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

/** The decision of a case: a comment, then "в порядке" or "нарушение" behind a confirmation (final). */
export function DecisionPanel({ item }: { item: FraudCase }) {
  if (item.status === 'open') return <OpenDecision caseId={item.id} />;
  return (
    <p role="status">
      {t('fraud.decision.done', { verdict: t(`fraud.card.status.${item.status}`) })}
    </p>
  );
}

function OpenDecision({ caseId }: { caseId: string }) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [comment, setComment] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const [pending, setPending] = useState<FraudDecisionValue | null>(null);
  const mutation = useDecision(caseId);

  function ask(decision: FraudDecisionValue) {
    const problem = commentProblem(comment);
    setInvalid(problem);
    if (problem) area.current?.focus();
    else setPending(decision);
  }

  return (
    <div className="stack">
      <CommentField
        id={`${id}-comment`}
        value={comment}
        error={invalid}
        areaRef={area}
        onChange={setComment}
      />
      <div className="row">
        <button type="button" className="button button-small" onClick={() => ask('ok')}>
          {t('fraud.decision.ok')}
        </button>
        <button
          type="button"
          className="button button-danger button-small"
          onClick={() => ask('violation')}
        >
          {t('fraud.decision.violation')}
        </button>
      </div>
      {pending ? (
        <ConfirmDialog
          decision={pending}
          pending={mutation.isPending}
          error={mutation.isError ? decisionErrorText(mutation.error) : null}
          onCancel={() => {
            mutation.reset();
            setPending(null);
          }}
          onConfirm={() => mutation.mutate({ decision: pending, comment: comment.trim() })}
        />
      ) : null}
    </div>
  );
}
