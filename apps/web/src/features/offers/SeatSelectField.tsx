'use client';

import { Field } from '@/components/ui/Field';
import type { CatalogEntry } from '@/features/profile/api';
import type { Seat } from '@/features/teams/api';
import { t } from '@/i18n';

export function openSeatLabel(seat: Seat, roles: readonly CatalogEntry[]): string {
  const role = roles.find((r) => r.code === seat.roleCode)?.name ?? seat.roleCode;
  return t('teams.seat.item', { n: seat.ordinal }) + ` · ${role}`;
}

interface Props {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  error: string | undefined;
  openSeats: readonly Seat[];
  roles: readonly CatalogEntry[];
  onChange: (seatId: string) => void;
}

/** Required select of an open seat, labelled "Место N · Роль". */
export function SeatSelectField(props: Props) {
  const { id, label, placeholder, value, error, openSeats, roles, onChange } = props;
  return (
    <Field id={id} label={label} error={error} required>
      {(c) => (
        <select {...c} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{placeholder}</option>
          {openSeats.map((seat) => (
            <option key={seat.id} value={seat.id}>
              {openSeatLabel(seat, roles)}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}
