import { t } from '@/i18n';
import { ApiError } from '@/lib/api/errors';
import type { ChecklistItem } from '@/features/route/api';
import type { ItemWrite } from './api';

export function isVersionConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && error.code === 'VERSION_CONFLICT';
}

function isChecklistItem(value: unknown): value is ChecklistItem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.version === 'number' &&
    (v.status === 'open' || v.status === 'done')
  );
}

/** The item carried by a 409 VERSION_CONFLICT (`problem.current`); `null` when it is unusable. */
export function currentFromConflict(error: unknown): ChecklistItem | null {
  if (!isVersionConflict(error)) return null;
  const current = error.problem?.current;
  return isChecklistItem(current) ? current : null;
}

export interface ConflictRow {
  field: string;
  mine: string;
  actual: string;
}

type PatchKey = keyof Extract<ItemWrite, { kind: 'patch' }>['patch'];

function empty(): string {
  return t('checklist.conflict.empty');
}

function textOf(value: string | null | undefined): string {
  return value ? value : empty();
}

function statusText(status: 'open' | 'done'): string {
  return t(`checklist.conflict.statusValue.${status}`);
}

const PATCH_ROWS: Record<
  PatchKey,
  { label: string; actual: (item: ChecklistItem) => string; mine: (value: unknown) => string }
> = {
  status: {
    label: t('checklist.conflict.field.status'),
    actual: (item) => statusText(item.status),
    mine: (value) => statusText(value === 'done' ? 'done' : 'open'),
  },
  linkUrl: {
    label: t('checklist.conflict.field.linkUrl'),
    actual: (item) => textOf(item.linkUrl),
    mine: (value) => textOf(value as string | null),
  },
  heldOn: {
    label: t('checklist.conflict.field.heldOn'),
    actual: (item) => textOf(item.heldOn),
    mine: (value) => textOf(value as string | null),
  },
  externalUrl: {
    label: t('checklist.conflict.field.externalUrl'),
    actual: (item) => textOf(item.externalUrl),
    mine: (value) => textOf(value as string | null),
  },
  outcome: {
    label: t('checklist.conflict.field.outcome'),
    actual: (item) => textOf(item.outcome),
    mine: (value) => textOf(value as string | null),
  },
  roleCode: {
    label: t('checklist.conflict.field.roleCode'),
    actual: (item) => textOf(item.roleCode),
    mine: (value) => textOf(value as string | null),
  },
};

/**
 * What the user was changing next to what the item holds now. Only fields of a plain patch can be
 * compared; other writes (assignment, review) get no rows and a generic explanation.
 */
export function conflictRows(write: ItemWrite, actual: ChecklistItem): ConflictRow[] {
  if (write.kind !== 'patch') return [];
  const keys = Object.keys(write.patch) as PatchKey[];
  return keys.flatMap((key) => {
    const row = PATCH_ROWS[key];
    return row
      ? [
          {
            field: row.label,
            mine: row.mine(write.patch[key]),
            actual: row.actual(actual),
          },
        ]
      : [];
  });
}
