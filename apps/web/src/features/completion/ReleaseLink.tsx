'use client';

import { useId, type FormEvent } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Field } from '@/components/ui/Field';
import { ConflictPanel } from '@/features/checklist/ConflictPanel';
import { useDraft } from '@/features/checklist/useDraft';
import { checkLink, itemErrorText } from '@/features/checklist/errors';
import { useItemWrites, type ItemWrites } from '@/features/checklist/useItemWrites';
import type { ChecklistItem, ProjectStage } from '@/features/route/api';
import { useChecklist, useStages } from '@/features/route/queries';
import { t } from '@/i18n';

const FINAL_LINKS_STEP = /_final_links$/;

/** The step of the last stage where the release link lives (FR-WORK-14). */
export function findReleaseItem(items: readonly ChecklistItem[] | undefined) {
  return items?.find((item) => FINAL_LINKS_STEP.test(item.stepKey));
}

function lastStageOf(stages: readonly ProjectStage[]): ProjectStage | undefined {
  return stages.reduce<ProjectStage | undefined>(
    (last, stage) => (!last || stage.ordinal > last.ordinal ? stage : last),
    undefined,
  );
}

function SaveRow({ disabled, writes }: { disabled: boolean; writes: ItemWrites }) {
  return (
    <>
      <div>
        <button
          type="submit"
          className="button button-secondary"
          disabled={disabled || writes.pending}
        >
          {writes.pending ? t('completion.release.saving') : t('completion.release.save')}
        </button>
      </div>
      <div role="status">{writes.savedCount > 0 ? t('completion.release.saved') : null}</div>
    </>
  );
}

function ReleaseOutcome({ item, writes }: { item: ChecklistItem; writes: ItemWrites }) {
  return (
    <>
      {writes.error ? <Alert tone="error">{itemErrorText(writes.error)}</Alert> : null}
      <ConflictPanel item={item} writes={writes} />
      {item.linkUrl ? (
        <p className="muted">
          {t('completion.release.current')}{' '}
          {item.linkUrl.startsWith('https://') ? (
            <a href={item.linkUrl} target="_blank" rel="noopener noreferrer">
              {item.linkUrl}
            </a>
          ) : (
            <span>{item.linkUrl}</span>
          )}
        </p>
      ) : null}
    </>
  );
}

function ReleaseLinkForm({
  teamId,
  item,
  editable,
}: {
  teamId: string;
  item: ChecklistItem;
  editable: boolean;
}) {
  const id = useId();
  const writes = useItemWrites(teamId, item);
  const { draft, setField } = useDraft<{ url: string }>(writes.savedCount);
  const value = draft.url ?? item.linkUrl ?? '';
  const changed = value.trim() !== (item.linkUrl ?? '');

  function save(event: FormEvent) {
    event.preventDefault();
    const verdict = checkLink(value);
    if (verdict !== 'ok') return writes.reportProblem(t(`completion.release.errors.${verdict}`));
    void writes.submit({ kind: 'patch', patch: { linkUrl: value.trim() } });
  }

  return (
    <form onSubmit={save} noValidate className="stack">
      <Field
        id={`${id}-release`}
        label={t('completion.release.label')}
        hint={t('completion.release.hint')}
        error={writes.problem ?? undefined}
      >
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
      <SaveRow disabled={!editable || !changed} writes={writes} />
      <ReleaseOutcome item={item} writes={writes} />
    </form>
  );
}

/** Saves the release link through the final-links step of the last stage. */
export function ReleaseLink({ teamId, suspended }: { teamId: string; suspended: boolean }) {
  const stages = useStages(teamId);
  const last = stages.data ? lastStageOf(stages.data.items) : undefined;
  const checklist = useChecklist(
    teamId,
    last?.ordinal ?? 0,
    Boolean(last && last.status !== 'pending'),
  );
  const item = findReleaseItem(checklist.data);

  if (stages.isError || checklist.isError) {
    return <Alert tone="error">{t('completion.release.loadFailed')}</Alert>;
  }
  if (stages.isPending || (last && last.status !== 'pending' && checklist.isPending)) {
    return <p role="status">{t('completion.release.loading')}</p>;
  }
  if (!last || !item) return <p className="muted">{t('completion.release.missingStep')}</p>;
  return (
    <ReleaseLinkForm teamId={teamId} item={item} editable={last.status === 'open' && !suspended} />
  );
}
