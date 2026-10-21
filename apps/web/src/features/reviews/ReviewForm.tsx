'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Field } from '@/components/ui/Field';
import { t } from '@/i18n';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import { createReview, sentKey, type MyTeam } from './api';
import { formatDateTimeDay, MAX_REVIEW_LENGTH, reviewErrorText, validateReview } from './model';

export interface Colleague {
  userId: string;
  name: string;
}

function useCreateReview(teamId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    mutationFn: (input: { subjectUserId: string; text: string }, key) =>
      createReview(teamId, input, key),
    onSettled: () => queryClient.invalidateQueries({ queryKey: sentKey(teamId) }),
  });
}

function TeamSelect({
  id,
  teams,
  value,
  onChange,
}: {
  id: string;
  teams: readonly MyTeam[];
  value: string;
  onChange: (teamId: string) => void;
}) {
  return (
    <Field id={id} label={t('reviews.form.team')}>
      {(control) => (
        <select {...control} value={value} onChange={(event) => onChange(event.target.value)}>
          {teams.map((item) => (
            <option key={item.team.id} value={item.team.id}>
              {item.team.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

interface FormProps {
  teams: readonly MyTeam[];
  teamId: string;
  onTeamChange: (teamId: string) => void;
  colleagues: readonly Colleague[];
  windowClosesAt: string | undefined;
}

interface Problems {
  colleague?: string;
  text?: string;
}

interface FieldsProps {
  id: string;
  colleagues: readonly Colleague[];
  subject: string;
  text: string;
  problems: Problems;
  onSubject: (value: string) => void;
  onText: (value: string) => void;
  subjectRef: React.RefObject<HTMLSelectElement | null>;
  textRef: React.RefObject<HTMLTextAreaElement | null>;
}

function ColleagueSelect(props: FieldsProps) {
  return (
    <Field
      id={`${props.id}-who`}
      label={t('reviews.form.colleague')}
      error={props.problems.colleague}
      required
    >
      {(control) => (
        <select
          {...control}
          ref={props.subjectRef}
          value={props.subject}
          onChange={(event) => props.onSubject(event.target.value)}
        >
          <option value="">{t('reviews.form.colleaguePlaceholder')}</option>
          {props.colleagues.map((colleague) => (
            <option key={colleague.userId} value={colleague.userId}>
              {colleague.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function TextField(props: FieldsProps) {
  return (
    <Field
      id={`${props.id}-text`}
      label={t('reviews.form.text')}
      hint={t('reviews.form.textHint')}
      error={props.problems.text}
      required
    >
      {(control) => (
        <textarea
          {...control}
          ref={props.textRef}
          rows={6}
          maxLength={MAX_REVIEW_LENGTH}
          value={props.text}
          onChange={(event) => props.onText(event.target.value)}
        />
      )}
    </Field>
  );
}

function useDraft(teamId: string) {
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<Problems>({});
  const subjectRef = useRef<HTMLSelectElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const mutation = useCreateReview(teamId);

  function submit(event: FormEvent) {
    event.preventDefault();
    const found = validateReview(subject, text);
    setProblems(found);
    if (found.colleague) return subjectRef.current?.focus();
    if (found.text) return textRef.current?.focus();
    mutation.mutate(
      { subjectUserId: subject, text: text.trim() },
      {
        onSuccess: () => {
          setSubject('');
          setText('');
        },
      },
    );
  }
  return { subject, setSubject, text, setText, problems, subjectRef, textRef, mutation, submit };
}

/** A private review of a colleague of a finished project (FR-PROF-08); the batch notice is aria-live. */
export function ReviewForm({ teams, teamId, onTeamChange, colleagues, windowClosesAt }: FormProps) {
  const id = useId();
  const draft = useDraft(teamId);
  const { mutation } = draft;
  const fields: FieldsProps = {
    id,
    colleagues,
    subject: draft.subject,
    text: draft.text,
    problems: draft.problems,
    onSubject: draft.setSubject,
    onText: draft.setText,
    subjectRef: draft.subjectRef,
    textRef: draft.textRef,
  };

  return (
    <form className="card stack" aria-labelledby={`${id}-title`} onSubmit={draft.submit} noValidate>
      <h2 id={`${id}-title`}>{t('reviews.form.title')}</h2>
      {teams.length > 1 ? (
        <TeamSelect id={`${id}-team`} teams={teams} value={teamId} onChange={onTeamChange} />
      ) : null}
      {windowClosesAt ? (
        <p className="muted">
          {t('reviews.form.windowCloses', { date: formatDateTimeDay(windowClosesAt) })}
        </p>
      ) : null}
      {colleagues.length === 0 ? (
        <p className="muted">{t('reviews.form.allSent')}</p>
      ) : (
        <>
          <ColleagueSelect {...fields} />
          <TextField {...fields} />
          <div>
            <button type="submit" className="button" disabled={mutation.isPending}>
              {mutation.isPending ? t('reviews.form.sending') : t('reviews.form.submit')}
            </button>
          </div>
        </>
      )}
      {mutation.isError ? <Alert tone="error">{reviewErrorText(mutation.error)}</Alert> : null}
      {mutation.isSuccess ? <Alert tone="info">{t('reviews.form.sent')}</Alert> : null}
    </form>
  );
}
