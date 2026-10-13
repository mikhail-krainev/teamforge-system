'use client';

import { Field } from '@/components/ui/Field';
import { t } from '@/i18n';
import type { CatalogEntry } from './api';
import { LEVELS, LIMITS, levelLabel, type Level, type ProfileDraft } from './model';

type Prefs = ProfileDraft['rolePrefs'];

interface Props {
  value: Prefs;
  roles: readonly CatalogEntry[];
  error?: string | undefined;
  onChange: (next: Prefs) => void;
}

function swap(list: Prefs, a: number, b: number): Prefs {
  const next = [...list];
  const first = next[a];
  const second = next[b];
  if (!first || !second) return list;
  next[a] = second;
  next[b] = first;
  return next;
}

/** Ordered list of desired roles: the position is the priority. */
export function RolePrefsEditor({ value, roles, error, onChange }: Props) {
  const nameOf = (code: string) => roles.find((r) => r.code === code)?.name ?? code;
  const free = roles.filter((r) => r.active && !value.some((v) => v.roleCode === r.code));
  return (
    <fieldset aria-describedby="roles-hint" className="stack">
      <legend>{t('profile.form.legendRoles')}</legend>
      <p id="roles-hint" className="muted">
        {t('profile.form.rolesHint')}
      </p>
      {value.length === 0 ? <p className="muted">{t('profile.form.rolesEmpty')}</p> : null}
      <ol className="pref-list">
        {value.map((pref, index) => (
          <RoleRow
            key={pref.roleCode}
            index={index}
            last={index === value.length - 1}
            name={nameOf(pref.roleCode)}
            level={pref.level}
            onLevel={(level) => onChange(value.map((p, i) => (i === index ? { ...p, level } : p)))}
            onMove={(to) => onChange(swap(value, index, to))}
            onRemove={() => onChange(value.filter((_, i) => i !== index))}
          />
        ))}
      </ol>
      {value.length < LIMITS.rolesMax ? (
        <Field id="role-add" label={t('profile.form.roleAdd')} error={error}>
          {(control) => (
            <select
              {...control}
              value=""
              onChange={(event) => {
                if (event.target.value) {
                  onChange([...value, { roleCode: event.target.value, level: 'beginner' }]);
                }
              }}
            >
              <option value="">{t('profile.form.rolePick')}</option>
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

interface RowProps {
  index: number;
  last: boolean;
  name: string;
  level: Level;
  onLevel: (level: Level) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}

function RoleRow({ index, last, name, level, onLevel, onMove, onRemove }: RowProps) {
  return (
    <li className="pref-row">
      <span className="pref-name">
        <span className="muted">{t('profile.form.rolePriority', { n: index + 1 })}: </span>
        <strong>{name}</strong>
      </span>
      <Field id={`role-level-${index}`} label={t('profile.form.levelSelect')}>
        {(control) => (
          <select {...control} value={level} onChange={(e) => onLevel(e.target.value as Level)}>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {levelLabel(l)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <div className="row">
        <button
          type="button"
          className="button button-secondary icon-button"
          disabled={index === 0}
          aria-label={t('profile.form.roleUp', { role: name })}
          onClick={() => onMove(index - 1)}
        >
          <span aria-hidden="true">↑</span>
        </button>
        <button
          type="button"
          className="button button-secondary icon-button"
          disabled={last}
          aria-label={t('profile.form.roleDown', { role: name })}
          onClick={() => onMove(index + 1)}
        >
          <span aria-hidden="true">↓</span>
        </button>
        <button
          type="button"
          className="button button-secondary icon-button"
          aria-label={t('profile.form.roleRemove', { role: name })}
          onClick={onRemove}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </li>
  );
}
