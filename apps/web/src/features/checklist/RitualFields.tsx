'use client';

import { useId, type FormEvent } from 'react';
import { Field } from '@/components/ui/Field';
import { t } from '@/i18n';
import type { ChecklistItem } from '@/features/route/api';
import type { ItemPatch } from './api';
import { checkLink } from './errors';
import { useDraft } from './useDraft';
import type { ItemWrites } from './useItemWrites';

const OUTCOME_MIN = 20;
const OUTCOME_MAX = 5000;

interface Fields extends Record<string, string> {
  heldOn: string;
  externalUrl: string;
  outcome: string;
}

interface Props {
  item: ChecklistItem;
  writes: ItemWrites;
  editable: boolean;
}

function savedFields(item: ChecklistItem): Fields {
  return {
    heldOn: item.heldOn ?? '',
    externalUrl: item.externalUrl ?? '',
    outcome: item.outcome ?? '',
  };
}

/** The patch with the fields the user changed, or a Russian message for the first invalid one. */
export function ritualPatch(
  values: Fields,
  saved: Fields,
): { patch: ItemPatch } | { problem: string } {
  const patch: ItemPatch = {};
  if (values.heldOn !== saved.heldOn) patch.heldOn = values.heldOn || null;
  if (values.externalUrl !== saved.externalUrl) {
    const trimmed = values.externalUrl.trim();
    if (trimmed !== '' && checkLink(trimmed) !== 'ok') {
      return { problem: t('checklist.ritual.invalidUrl') };
    }
    patch.externalUrl = trimmed || null;
  }
  if (values.outcome !== saved.outcome) {
    const outcome = values.outcome.trim();
    if (outcome !== '' && outcome.length < OUTCOME_MIN) {
      return { problem: t('checklist.ritual.outcomeShort') };
    }
    patch.outcome = outcome || null;
  }
  return { patch };
}

interface InputsProps {
  id: string;
  values: Fields;
  disabled: boolean;
  onChange: (field: keyof Fields, value: string) => void;
}

function RitualInputs({ id, values, disabled, onChange }: InputsProps) {
  return (
    <>
      <Field id={`${id}-held`} label={t('checklist.ritual.heldOn')}>
        {(control) => (
          <input
            {...control}
            type="date"
            value={values.heldOn}
            disabled={disabled}
            onChange={(event) => onChange('heldOn', event.target.value)}
          />
        )}
      </Field>
      <Field
        id={`${id}-url`}
        label={t('checklist.ritual.externalUrl')}
        hint={t('checklist.ritual.externalUrlHint')}
      >
        {(control) => (
          <input
            {...control}
            type="text"
            inputMode="url"
            autoComplete="off"
            value={values.externalUrl}
            disabled={disabled}
            onChange={(event) => onChange('externalUrl', event.target.value)}
          />
        )}
      </Field>
      <Field
        id={`${id}-outcome`}
        label={t('checklist.ritual.outcome')}
        hint={t('checklist.ritual.outcomeHint')}
      >
        {(control) => (
          <textarea
            {...control}
            rows={4}
            maxLength={OUTCOME_MAX}
            value={values.outcome}
            disabled={disabled}
            onChange={(event) => onChange('outcome', event.target.value)}
          />
        )}
      </Field>
    </>
  );
}

/** Date, call link and outcome of a ritual step (FR-WORK-06); only changed fields are sent. */
export function RitualFields({ item, writes, editable }: Props) {
  const id = useId();
  const { draft, setField } = useDraft<Fields>(writes.savedCount);
  const saved = savedFields(item);
  const values: Fields = {
    heldOn: draft.heldOn ?? saved.heldOn,
    externalUrl: draft.externalUrl ?? saved.externalUrl,
    outcome: draft.outcome ?? saved.outcome,
  };
  const changed = (Object.keys(saved) as (keyof Fields)[]).some((k) => values[k] !== saved[k]);

  function save(event: FormEvent) {
    event.preventDefault();
    const result = ritualPatch(values, saved);
    if ('problem' in result) return writes.reportProblem(result.problem);
    void writes.submit({ kind: 'patch', patch: result.patch });
  }

  return (
    <form onSubmit={save} noValidate className="stack">
      <RitualInputs id={id} values={values} disabled={!editable} onChange={setField} />
      <div>
        <button
          type="submit"
          className="button button-secondary"
          disabled={!editable || writes.pending || !changed}
        >
          {t('checklist.ritual.save')}
        </button>
      </div>
    </form>
  );
}
