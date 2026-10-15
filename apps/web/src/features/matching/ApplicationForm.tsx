'use client';

import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/Alert';
import type { CatalogEntry } from '@/features/profile/api';
import { useFocusInvalid } from '@/features/teams/useFocusInvalid';
import { t } from '@/i18n';
import { RolePriorityEditor } from './RolePriorityEditor';

interface Props {
  mode: 'create' | 'update';
  initial: readonly string[];
  roles: readonly CatalogEntry[];
  pending: boolean;
  onSubmit: (codes: string[]) => void;
  /** Called on every edit, so the parent can drop a stale success message. */
  onEdit?: () => void;
}

/** Roles with priorities for the queue application; changing an active one shows a warning. */
export function ApplicationForm({ mode, initial, roles, pending, onSubmit, onEdit }: Props) {
  const [codes, setCodes] = useState<string[]>([...initial]);
  const [error, setError] = useState<string | undefined>();
  const focus = useFocusInvalid();
  const update = mode === 'update';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (codes.length === 0) {
      setError(t('matching.search.rolesRequired'));
      focus('application-role-add');
      return;
    }
    setError(undefined);
    onSubmit(codes);
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      className="card stack"
      aria-label={update ? t('matching.search.editTitle') : t('matching.search.createTitle')}
    >
      <h2>{update ? t('matching.search.editTitle') : t('matching.search.createTitle')}</h2>
      {update ? <Alert tone="warn">{t('matching.search.changeWarning')}</Alert> : null}
      <RolePriorityEditor
        value={codes}
        roles={roles}
        error={error}
        onChange={(next) => {
          setCodes(next);
          setError(undefined);
          onEdit?.();
        }}
      />
      <div>
        <button type="submit" className="button" disabled={pending}>
          {pending
            ? update
              ? t('matching.search.saving')
              : t('matching.search.creating')
            : update
              ? t('matching.search.save')
              : t('matching.search.create')}
        </button>
      </div>
    </form>
  );
}
