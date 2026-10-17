'use client';

import { Field } from '@/components/ui/Field';
import type { CatalogEntry } from '@/features/profile/api';
import { t } from '@/i18n';
import { MAX_APPLICATION_ROLES } from './api';

interface Props {
  /** Role codes in priority order: the first one is the most wanted. */
  value: readonly string[];
  roles: readonly CatalogEntry[];
  error?: string | undefined;
  onChange: (next: string[]) => void;
}

function swap(list: readonly string[], a: number, b: number): string[] {
  const next = [...list];
  const first = next[a];
  const second = next[b];
  if (first === undefined || second === undefined) return next;
  next[a] = second;
  next[b] = first;
  return next;
}

interface RowProps {
  index: number;
  last: boolean;
  name: string;
  onMove: (to: number) => void;
  onRemove: () => void;
}

function RoleRow({ index, last, name, onMove, onRemove }: RowProps) {
  return (
    <li className="row application-role">
      <span className="pref-name">
        <span className="muted">{t('matching.search.rolePriority', { n: index + 1 })}: </span>
        <strong>{name}</strong>
      </span>
      <button
        type="button"
        className="button button-secondary icon-button"
        disabled={index === 0}
        aria-label={t('matching.search.roleUp', { role: name })}
        onClick={() => onMove(index - 1)}
      >
        <span aria-hidden="true">↑</span>
      </button>
      <button
        type="button"
        className="button button-secondary icon-button"
        disabled={last}
        aria-label={t('matching.search.roleDown', { role: name })}
        onClick={() => onMove(index + 1)}
      >
        <span aria-hidden="true">↓</span>
      </button>
      <button
        type="button"
        className="button button-secondary icon-button"
        aria-label={t('matching.search.roleRemove', { role: name })}
        onClick={onRemove}
      >
        <span aria-hidden="true">×</span>
      </button>
    </li>
  );
}

/** Ordered list of roles for the queue application: the position is the priority (1 = highest). */
export function RolePriorityEditor({ value, roles, error, onChange }: Props) {
  const nameOf = (code: string) => roles.find((r) => r.code === code)?.name ?? code;
  const free = roles.filter((r) => r.active && !value.includes(r.code));
  return (
    <fieldset aria-describedby="application-roles-hint" className="stack">
      <legend>{t('matching.search.legend')}</legend>
      <p id="application-roles-hint" className="muted">
        {t('matching.search.hint')}
      </p>
      {value.length === 0 ? <p className="muted">{t('matching.search.empty')}</p> : null}
      <ol className="pref-list">
        {value.map((code, index) => (
          <RoleRow
            key={code}
            index={index}
            last={index === value.length - 1}
            name={nameOf(code)}
            onMove={(to) => onChange(swap(value, index, to))}
            onRemove={() => onChange(value.filter((c) => c !== code))}
          />
        ))}
      </ol>
      {value.length < MAX_APPLICATION_ROLES ? (
        <Field id="application-role-add" label={t('matching.search.roleAdd')} error={error}>
          {(control) => (
            <select
              {...control}
              value=""
              onChange={(event) => {
                if (event.target.value) onChange([...value, event.target.value]);
              }}
            >
              <option value="">{t('matching.search.rolePick')}</option>
              {free.map((role) => (
                <option key={role.code} value={role.code}>
                  {role.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}
    </fieldset>
  );
}
