'use client';

import { useId, useState, type FormEvent } from 'react';
import { t } from '@/i18n';
import type { ReviewAnswers } from '@/features/checklist/api';

interface Props {
  points: readonly string[];
  pending: boolean;
  onSubmit: (answers: ReviewAnswers) => void;
  onCancel: () => void;
}

type Choice = boolean | undefined;

function PointChoice({
  index,
  text,
  value,
  onChange,
  group,
}: {
  index: number;
  text: string;
  value: Choice;
  onChange: (answer: boolean) => void;
  group: string;
}) {
  const name = `${group}-${index}`;
  return (
    <fieldset className="field">
      <legend className="field-label">{text}</legend>
      <div className="row">
        <label className="checkbox">
          <input
            type="radio"
            name={name}
            checked={value === true}
            onChange={() => onChange(true)}
          />
          {t('review.yes')}
        </label>
        <label className="checkbox">
          <input
            type="radio"
            name={name}
            checked={value === false}
            onChange={() => onChange(false)}
          />
          {t('review.no')}
        </label>
      </div>
    </fieldset>
  );
}

/** The review checklist of an item (FR-WORK-09): a yes/no answer per point of the playbook step. */
export function ReviewForm({ points, pending, onSubmit, onCancel }: Props) {
  const [choices, setChoices] = useState<Choice[]>(() => points.map(() => undefined));
  const group = useId();
  const complete = choices.every((choice) => choice !== undefined);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!complete) return;
    onSubmit(choices.map((answer, index) => ({ ordinal: index + 1, answer: answer === true })));
  }

  return (
    <form onSubmit={submit} className="stack">
      <fieldset className="card nested stack">
        <legend className="field-label">{t('review.group')}</legend>
        <p className="muted">{t('review.hint')}</p>
        {points.map((text, index) => (
          <PointChoice
            key={`${index}`}
            index={index}
            text={text}
            group={group}
            value={choices[index]}
            onChange={(answer) =>
              setChoices((previous) => previous.map((c, i) => (i === index ? answer : c)))
            }
          />
        ))}
        {complete ? null : <p className="muted">{t('review.unanswered')}</p>}
        <div className="row">
          <button type="submit" className="button" disabled={pending || !complete}>
            {pending ? t('review.submitting') : t('review.submit')}
          </button>
          <button type="button" className="button button-secondary" onClick={onCancel}>
            {t('review.cancel')}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
