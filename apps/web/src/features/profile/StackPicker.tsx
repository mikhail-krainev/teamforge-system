'use client';

import { useState } from 'react';
import { Field } from '@/components/ui/Field';
import { t } from '@/i18n';
import type { CatalogEntry } from './api';
import { LIMITS } from './model';

const VISIBLE_MAX = 60;

interface Props {
  value: string[];
  tags: readonly CatalogEntry[];
  error?: string | undefined;
  onChange: (next: string[]) => void;
}

/** Multi-select of catalog tags: a filter box over a checkbox list (keyboard and screen reader friendly). */
export function StackPicker({ value, tags, error, onChange }: Props) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const shown = tags
    .filter((tag) => tag.active || value.includes(tag.code))
    .filter((tag) => needle === '' || `${tag.code} ${tag.name}`.toLowerCase().includes(needle))
    .slice(0, VISIBLE_MAX);

  function toggle(code: string, checked: boolean) {
    if (!checked) onChange(value.filter((c) => c !== code));
    else if (value.length < LIMITS.stackMax) onChange([...value, code]);
  }

  return (
    <fieldset className="stack">
      <legend>{t('profile.form.legendStack')}</legend>
      <Field
        id="stack-search"
        label={t('profile.form.stackSearch')}
        hint={t('profile.form.stackHint')}
        error={error}
      >
        {(control) => (
          <input
            {...control}
            type="text"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
      </Field>
      <p className="muted" role="status" aria-live="polite">
        {t('profile.form.stackSelected', { count: value.length })}
      </p>
      {shown.length === 0 ? <p className="muted">{t('profile.form.stackNone')}</p> : null}
      <StackList tags={shown} value={value} onToggle={toggle} />
    </fieldset>
  );
}

interface ListProps {
  tags: readonly CatalogEntry[];
  value: string[];
  onToggle: (code: string, checked: boolean) => void;
}

function StackList({ tags, value, onToggle }: ListProps) {
  return (
    <ul className="check-grid">
      {tags.map((tag) => {
        const checked = value.includes(tag.code);
        return (
          <li key={tag.code}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={checked}
                disabled={!checked && value.length >= LIMITS.stackMax}
                onChange={(event) => onToggle(tag.code, event.target.checked)}
              />
              {tag.name}
            </label>
          </li>
        );
      })}
    </ul>
  );
}
