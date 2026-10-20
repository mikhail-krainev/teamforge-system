'use client';

import { useState } from 'react';
import { t } from '@/i18n';
import type { ChecklistItem } from '@/features/route/api';
import { useTemplate } from '@/features/route/queries';
import type { ItemWrites } from './useItemWrites';

function TemplateViewer({ templateKey, title }: { templateKey: string; title: string }) {
  const [open, setOpen] = useState(false);
  const template = useTemplate(templateKey, open);
  return (
    <div className="stack">
      <div>
        <button
          type="button"
          className="button button-secondary"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {t('checklist.fallback.template', { title })}
        </button>
      </div>
      {open && template.isPending ? (
        <p role="status">{t('checklist.fallback.templateLoading')}</p>
      ) : null}
      {open && template.isError ? (
        <p className="field-error">{t('checklist.fallback.templateFailed')}</p>
      ) : null}
      {open && template.data ? <pre className="pre-text">{template.data.bodyMd}</pre> : null}
    </div>
  );
}

interface Props {
  item: ChecklistItem;
  writes: ItemWrites;
  isLead: boolean;
  editable: boolean;
}

/**
 * The fallback step of a step whose role nobody holds (FR-WORK-02): the instruction and the
 * platform template. Optional steps show it as advice; the lead can return to the usual step.
 */
export function FallbackBlock({ item, writes, isLead, editable }: Props) {
  const fallback = item.fallback;
  if (!item.fallbackUsed || !fallback) return null;
  return (
    <section className="stack">
      <p>
        <strong>
          {t(item.required ? 'checklist.fallback.heading' : 'checklist.fallback.advice', {
            title: fallback.title,
          })}
        </strong>
      </p>
      <p>{fallback.instruction}</p>
      <TemplateViewer templateKey={fallback.template} title={fallback.title} />
      {isLead && item.status === 'open' ? (
        <div className="stack">
          <p className="muted">{t('checklist.fallback.revertHint')}</p>
          <div>
            <button
              type="button"
              className="button button-secondary"
              disabled={!editable || writes.pending}
              onClick={() => void writes.submit({ kind: 'revertFallback' })}
            >
              {t('checklist.fallback.revert')}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
