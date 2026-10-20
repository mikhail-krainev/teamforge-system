'use client';

import { useId, type FormEvent } from 'react';
import { Field } from '@/components/ui/Field';
import { t } from '@/i18n';
import type { ChecklistItem } from '@/features/route/api';
import { checkLink } from './errors';
import { useDraft } from './useDraft';
import type { ItemWrites } from './useItemWrites';

interface Props {
  item: ChecklistItem;
  writes: ItemWrites;
  editable: boolean;
}

function SavedLink({ url }: { url: string }) {
  // Only https is ever rendered as an anchor: the stored value is data, not a trusted URL.
  if (!url.startsWith('https://')) return <span>{url}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {url}
    </a>
  );
}

/** The result of the worker's link check, announced politely when it changes (FR-WORK-04). */
function LinkStatus({ item }: { item: ChecklistItem }) {
  if (item.linkStatus === 'none') return null;
  return (
    <p
      role="status"
      aria-live="polite"
      aria-label={t('checklist.link.statusLabel')}
      className={item.linkStatus === 'ok' ? undefined : 'muted'}
    >
      {t(`checklist.link.${item.linkStatus}`)}
    </p>
  );
}

/** Link input of an artifact step with `submission` link or either (only https is accepted). */
export function ItemLink({ item, writes, editable }: Props) {
  const id = useId();
  const { draft, setField } = useDraft<{ url: string }>(writes.savedCount);
  const value = draft.url ?? item.linkUrl ?? '';
  const changed = value.trim() !== (item.linkUrl ?? '');

  function save(event: FormEvent) {
    event.preventDefault();
    const verdict = checkLink(value);
    if (verdict !== 'ok') return writes.reportProblem(t(`checklist.link.errors.${verdict}`));
    void writes.submit({ kind: 'patch', patch: { linkUrl: value.trim() } });
  }

  return (
    <form onSubmit={save} noValidate className="stack">
      <Field id={`${id}-link`} label={t('checklist.link.label')} hint={t('checklist.link.hint')}>
        {(control) => (
          <input
            {...control}
            type="text"
            inputMode="url"
            autoComplete="off"
            value={value}
            disabled={!editable}
            onChange={(event) => setField('url', event.target.value)}
          />
        )}
      </Field>
      <div>
        <button
          type="submit"
          className="button button-secondary"
          disabled={!editable || writes.pending || !changed}
        >
          {t('checklist.link.save')}
        </button>
      </div>
      <LinkStatus item={item} />
      {item.linkUrl ? (
        <p className="muted">
          {t('checklist.link.current')} <SavedLink url={item.linkUrl} />
        </p>
      ) : null}
    </form>
  );
}
