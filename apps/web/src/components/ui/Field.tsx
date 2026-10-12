import type { ReactNode } from 'react';

export interface FieldControlProps {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
  'aria-required'?: true;
}

interface FieldProps {
  id: string;
  label: string;
  hint?: string | undefined;
  /** When set the control is marked invalid and the message is tied to it by `aria-describedby`. */
  error?: string | undefined;
  required?: boolean;
  children: (control: FieldControlProps) => ReactNode;
}

/** Visible label + optional hint + error message, wired to the control through ARIA. */
export function Field({ id, label, hint, error, required, children }: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const control: FieldControlProps = {
    id,
    'aria-describedby': describedBy,
    'aria-invalid': error ? true : undefined,
    ...(required ? { 'aria-required': true as const } : {}),
  };
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="field-hint muted">
          {hint}
        </p>
      ) : null}
      {children(control)}
      {error ? (
        <p id={errorId} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
