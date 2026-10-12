'use client';

import type { SelectHTMLAttributes } from 'react';

function allTimezones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
  return intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : ['UTC'];
}

export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> & {
  value: string;
  onChange: (value: string) => void;
};

/** IANA zone picker; a stored value that the browser does not list is kept as an option. */
export function TimezoneSelect({ value, onChange, ...rest }: Props) {
  const zones = allTimezones();
  const options = zones.includes(value) || value === '' ? zones : [value, ...zones];
  return (
    <select {...rest} value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((zone) => (
        <option key={zone} value={zone}>
          {zone}
        </option>
      ))}
    </select>
  );
}
