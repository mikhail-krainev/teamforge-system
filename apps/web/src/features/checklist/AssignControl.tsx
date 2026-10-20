'use client';

import { useId, useState, type FormEvent } from 'react';
import { Field } from '@/components/ui/Field';
import { t } from '@/i18n';
import type { Member } from '@/features/teams/api';
import type { ChecklistItem } from '@/features/route/api';
import type { ItemWrites } from './useItemWrites';

interface Props {
  item: ChecklistItem;
  writes: ItemWrites;
  members: readonly Member[];
  editable: boolean;
}

/** Lead only (FR-WORK-03): picks an active member as the executor of the item. */
export function AssignControl({ item, writes, members, editable }: Props) {
  const id = useId();
  const [userId, setUserId] = useState('');
  const active = members.filter((member) => member.status === 'active');

  function assign(event: FormEvent) {
    event.preventDefault();
    if (userId) void writes.submit({ kind: 'assign', userId });
  }

  return (
    <form onSubmit={assign} className="stack">
      <Field id={`${id}-assignee`} label={t('checklist.assign.label')}>
        {(control) => (
          <select
            {...control}
            value={userId}
            disabled={!editable}
            onChange={(event) => setUserId(event.target.value)}
          >
            <option value="">{t('checklist.assign.placeholder')}</option>
            {active.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.displayName}
              </option>
            ))}
          </select>
        )}
      </Field>
      <div>
        <button
          type="submit"
          className="button button-secondary"
          disabled={!editable || writes.pending || !userId || userId === item.assigneeUserId}
        >
          {t('checklist.assign.submit')}
        </button>
      </div>
    </form>
  );
}
