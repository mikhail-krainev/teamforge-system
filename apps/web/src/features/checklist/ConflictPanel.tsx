'use client';

import { t } from '@/i18n';
import type { ChecklistItem } from '@/features/route/api';
import { conflictRows } from './conflict';
import type { ItemWrites } from './useItemWrites';

/**
 * Shown after 409 VERSION_CONFLICT (FR-WORK-07): what the item holds now next to what the user
 * was saving, with the choice to save it again over the actual version or to drop it.
 * It is an alert (not a status): the user's save did not happen and must be noticed at once.
 */
export function ConflictPanel({ item, writes }: { item: ChecklistItem; writes: ItemWrites }) {
  const conflict = writes.conflict;
  if (!conflict) return null;
  const actual = conflict.current ?? item;
  const rows = conflictRows(conflict.write, actual);
  return (
    <div role="alert" className="alert alert-warn stack">
      <p>
        <strong>{t('checklist.conflict.title')}</strong>
      </p>
      <p>{t('checklist.conflict.body')}</p>
      {rows.length > 0 ? (
        <dl className="definition-list">
          {rows.map((row) => (
            <ConflictRowView key={row.field} row={row} />
          ))}
        </dl>
      ) : null}
      <div className="row">
        <button
          type="button"
          className="button"
          disabled={writes.pending}
          onClick={() => void writes.reapply()}
        >
          {writes.pending ? t('checklist.conflict.reapplying') : t('checklist.conflict.reapply')}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={writes.pending}
          onClick={writes.dismissConflict}
        >
          {t('checklist.conflict.dismiss')}
        </button>
      </div>
    </div>
  );
}

function ConflictRowView({ row }: { row: { field: string; mine: string; actual: string } }) {
  return (
    <>
      <dt>{t('checklist.conflict.currentOf', { field: row.field })}</dt>
      <dd>
        <q className="pre-text">{row.actual}</q>
      </dd>
      <dt>{t('checklist.conflict.mineOf', { field: row.field })}</dt>
      <dd>
        <q className="pre-text">{row.mine}</q>
      </dd>
    </>
  );
}
