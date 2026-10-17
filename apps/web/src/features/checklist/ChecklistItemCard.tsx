'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { t } from '@/i18n';
import { ArtifactFiles } from '@/features/artifacts/ArtifactFiles';
import { ReviewSection } from '@/features/review/ReviewSection';
import type { ChecklistItem, PlaybookStep } from '@/features/route/api';
import type { Member } from '@/features/teams/api';
import { AssignControl } from './AssignControl';
import { ConflictPanel } from './ConflictPanel';
import { itemErrorText } from './errors';
import { FallbackBlock } from './FallbackBlock';
import { ItemLink } from './ItemLink';
import { RitualFields } from './RitualFields';
import { useItemWrites, type ItemWrites } from './useItemWrites';

export interface ItemContext {
  teamId: string;
  meId: string;
  isLead: boolean;
  members: readonly Member[];
  /** The stage is open and the team is not suspended. */
  editable: boolean;
}

interface Props {
  item: ChecklistItem;
  step: PlaybookStep | undefined;
  context: ItemContext;
}

function assigneeLine(item: ChecklistItem, members: readonly Member[]): string {
  if (!item.assigneeUserId) return t('checklist.assigneeNone');
  const member = members.find((m) => m.userId === item.assigneeUserId);
  return t('checklist.assignee', { name: member?.displayName ?? t('checklist.unknownMember') });
}

function DoneToggle({
  item,
  writes,
  editable,
}: {
  item: ChecklistItem;
  writes: ItemWrites;
  editable: boolean;
}) {
  // Shown as soon as it is clicked: the server answer follows, and a refusal puts it back.
  const [asked, setAsked] = useState<ChecklistItem['status'] | null>(null);
  const shown = asked ?? item.status;

  function toggle() {
    const next = shown === 'done' ? 'open' : 'done';
    setAsked(next);
    void writes.submit({ kind: 'patch', patch: { status: next } }).then(() => setAsked(null));
  }

  return (
    <label className="checkbox">
      <input type="checkbox" checked={shown === 'done'} disabled={!editable} onChange={toggle} />
      {t('checklist.done')}
    </label>
  );
}

function SubmissionFields({
  item,
  writes,
  context,
}: {
  item: ChecklistItem;
  writes: ItemWrites;
  context: ItemContext;
}) {
  if (item.kind === 'ritual') {
    return <RitualFields item={item} writes={writes} editable={context.editable} />;
  }
  const wantsLink = item.submission === 'link' || item.submission === 'either';
  const wantsFile = item.submission === 'file' || item.submission === 'either';
  return (
    <>
      {wantsLink ? <ItemLink item={item} writes={writes} editable={context.editable} /> : null}
      {wantsFile ? (
        <ArtifactFiles
          teamId={context.teamId}
          item={item}
          meId={context.meId}
          isLead={context.isLead}
          editable={context.editable}
        />
      ) : null}
    </>
  );
}

/** One checklist item of a stage: executor, status, link / files / ritual fields, review, lead tools. */
export function ChecklistItemCard({ item, step, context }: Props) {
  const writes = useItemWrites(context.teamId, item);
  const failure = writes.problem ?? (writes.error ? itemErrorText(writes.error) : null);
  const { editable, isLead } = context;

  return (
    <li className="card nested stack">
      <h3>{item.title}</h3>
      <p>{assigneeLine(item, context.members)}</p>
      <p className="muted">
        {t('checklist.meta', {
          requirement: t(item.required ? 'checklist.required' : 'checklist.optional'),
          kind: t(`checklist.kind.${item.kind}`),
        })}
      </p>
      {step?.description ? <p className="muted">{step.description}</p> : null}
      <FallbackBlock item={item} writes={writes} isLead={isLead} editable={editable} />
      <SubmissionFields item={item} writes={writes} context={context} />
      <DoneToggle item={item} writes={writes} editable={editable} />
      <ReviewSection
        item={item}
        writes={writes}
        points={step?.reviewChecklist ? step.reviewItems : []}
        meId={context.meId}
        isLead={isLead}
        editable={editable}
      />
      {isLead && item.status === 'open' ? (
        <AssignControl item={item} writes={writes} members={context.members} editable={editable} />
      ) : null}
      <ConflictPanel item={item} writes={writes} />
      {failure ? <Alert tone="error">{failure}</Alert> : null}
    </li>
  );
}
