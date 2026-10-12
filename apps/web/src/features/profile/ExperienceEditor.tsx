'use client';

import { Field } from '@/components/ui/Field';
import { t } from '@/i18n';
import { LIMITS, type DraftErrors, type ExperienceDraft } from './model';

interface Props {
  value: ExperienceDraft[];
  errors: DraftErrors;
  onChange: (next: ExperienceDraft[]) => void;
}

const BLANK: ExperienceDraft = { title: '', description: '', from: '', to: '' };

export function ExperienceEditor({ value, errors, onChange }: Props) {
  const patch = (index: number, change: Partial<ExperienceDraft>) =>
    onChange(value.map((item, i) => (i === index ? { ...item, ...change } : item)));
  return (
    <fieldset className="stack">
      <legend>{t('profile.form.legendExperience')}</legend>
      {value.length === 0 ? <p className="muted">{t('profile.form.experienceEmpty')}</p> : null}
      {value.map((item, index) => (
        <ExperienceRow
          // Rows have no identity of their own; they are edited in place and removed by index.
          key={index}
          index={index}
          item={item}
          errors={errors}
          onPatch={(change) => patch(index, change)}
          onRemove={() => onChange(value.filter((_, i) => i !== index))}
        />
      ))}
      {value.length < LIMITS.experienceMax ? (
        <button
          type="button"
          className="button button-secondary"
          onClick={() => onChange([...value, { ...BLANK }])}
        >
          {t('profile.form.experienceAdd')}
        </button>
      ) : null}
    </fieldset>
  );
}

interface RowProps {
  index: number;
  item: ExperienceDraft;
  errors: DraftErrors;
  onPatch: (change: Partial<ExperienceDraft>) => void;
  onRemove: () => void;
}

function ExperienceRow({ index, item, errors, onPatch, onRemove }: RowProps) {
  const err = (field: string) => {
    const key = errors[`experience.${index}.${field}`];
    return key ? t(key) : undefined;
  };
  return (
    <div
      className="card nested stack"
      role="group"
      aria-label={t('profile.form.experienceItem', { n: index + 1 })}
    >
      <Field
        id={`exp-title-${index}`}
        label={t('profile.form.experienceTitle')}
        error={err('title')}
        required
      >
        {(c) => (
          <input
            {...c}
            type="text"
            maxLength={LIMITS.titleMax}
            value={item.title}
            onChange={(e) => onPatch({ title: e.target.value })}
          />
        )}
      </Field>
      <Field
        id={`exp-desc-${index}`}
        label={t('profile.form.experienceDescription')}
        error={err('description')}
      >
        {(c) => (
          <textarea
            {...c}
            maxLength={LIMITS.descriptionMax}
            value={item.description}
            onChange={(e) => onPatch({ description: e.target.value })}
          />
        )}
      </Field>
      <DateFields index={index} item={item} err={err} onPatch={onPatch} />
      <button type="button" className="button button-secondary" onClick={onRemove}>
        {t('profile.form.experienceRemove', { n: index + 1 })}
      </button>
    </div>
  );
}

interface DateProps {
  index: number;
  item: ExperienceDraft;
  err: (field: string) => string | undefined;
  onPatch: (change: Partial<ExperienceDraft>) => void;
}

function DateFields({ index, item, err, onPatch }: DateProps) {
  return (
    <div className="grid-2">
      <Field
        id={`exp-from-${index}`}
        label={t('profile.form.experienceFrom')}
        error={err('from')}
        required
      >
        {(c) => (
          <input
            {...c}
            type="date"
            value={item.from}
            onChange={(e) => onPatch({ from: e.target.value })}
          />
        )}
      </Field>
      <Field
        id={`exp-to-${index}`}
        label={t('profile.form.experienceTo')}
        hint={t('profile.form.experienceToHint')}
        error={err('to')}
      >
        {(c) => (
          <input
            {...c}
            type="date"
            value={item.to}
            onChange={(e) => onPatch({ to: e.target.value })}
          />
        )}
      </Field>
    </div>
  );
}
