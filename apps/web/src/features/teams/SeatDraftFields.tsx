'use client';

import { Field } from '@/components/ui/Field';
import type { CatalogEntry } from '@/features/profile/api';
import { t } from '@/i18n';
import type { Level } from './api';
import { LEVELS, LIMITS, levelLabel, type SeatDraft } from './model';

interface FieldsProps {
  prefix: string;
  seat: SeatDraft;
  error: (id: string) => string | undefined;
  onChange: (change: Partial<SeatDraft>) => void;
}

interface Props extends FieldsProps {
  /** 1-based position shown in labels. */
  position: number;
  roles: readonly CatalogEntry[];
  onRemove: () => void;
}

function RoleAndLevel({
  prefix,
  seat,
  roles,
  error,
  onChange,
}: FieldsProps & { roles: readonly CatalogEntry[] }) {
  return (
    <>
      <Field
        id={`${prefix}-roleCode`}
        label={t('teams.seat.role')}
        error={error(`${prefix}-roleCode`)}
        required
      >
        {(c) => (
          <select
            {...c}
            value={seat.roleCode}
            onChange={(e) => onChange({ roleCode: e.target.value })}
          >
            <option value="">{t('teams.seat.rolePick')}</option>
            {roles
              .filter((role) => role.active)
              .map((role) => (
                <option key={role.code} value={role.code}>
                  {role.name}
                </option>
              ))}
          </select>
        )}
      </Field>
      <Field id={`${prefix}-minLevel`} label={t('teams.seat.minLevel')}>
        {(c) => (
          <select
            {...c}
            value={seat.minLevel}
            onChange={(e) => onChange({ minLevel: e.target.value as Level })}
          >
            {LEVELS.map((level) => (
              <option key={level} value={level}>
                {levelLabel(level)}
              </option>
            ))}
          </select>
        )}
      </Field>
    </>
  );
}

function HoursAndCount({ prefix, seat, error, onChange }: FieldsProps) {
  return (
    <>
      <Field
        id={`${prefix}-minHours`}
        label={t('teams.seat.minHours')}
        hint={t('teams.seat.minHoursHint')}
        error={error(`${prefix}-minHours`)}
        required
      >
        {(c) => (
          <input
            {...c}
            type="number"
            inputMode="numeric"
            min={LIMITS.hoursMin}
            max={LIMITS.hoursMax}
            value={seat.minHours}
            onChange={(e) => onChange({ minHours: e.target.value })}
          />
        )}
      </Field>
      <Field
        id={`${prefix}-count`}
        label={t('teams.seat.count')}
        error={error(`${prefix}-count`)}
        required
      >
        {(c) => (
          <input
            {...c}
            type="number"
            inputMode="numeric"
            min={1}
            max={LIMITS.seatCountMax}
            value={seat.count}
            onChange={(e) => onChange({ count: e.target.value })}
          />
        )}
      </Field>
    </>
  );
}

/** One seat of the create-team and add-seats forms. */
export function SeatDraftFields({ position, roles, onRemove, ...fields }: Props) {
  const { seat, onChange } = fields;
  return (
    <fieldset className="card nested stack">
      <legend>{t('teams.seat.item', { n: position })}</legend>
      <div className="grid-2">
        <RoleAndLevel {...fields} roles={roles} />
        <HoursAndCount {...fields} />
      </div>
      <label className="row">
        <input
          type="checkbox"
          checked={seat.desired}
          onChange={(e) => onChange({ desired: e.target.checked })}
        />
        <span>{t('teams.seat.desired')}</span>
      </label>
      <div>
        <button type="button" className="button button-secondary" onClick={onRemove}>
          {t('teams.seat.remove', { n: position })}
        </button>
      </div>
    </fieldset>
  );
}
