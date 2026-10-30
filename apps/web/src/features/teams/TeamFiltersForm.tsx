'use client';

import { useState, type FormEvent } from 'react';
import { Field } from '@/components/ui/Field';
import { useRoles } from '@/features/profile/useProfileQueries';
import { t } from '@/i18n';
import { EMPTY_FILTERS, type TeamFilters } from './api';
import { useProductTypes } from './queries';

interface Props {
  applied: TeamFilters;
  onApply: (filters: TeamFilters) => void;
  /** Number of teams found; shown on the right once the list is complete. */
  count?: number;
}

interface FieldsProps {
  draft: TeamFilters;
  patch: (change: Partial<TeamFilters>) => void;
}

function CatalogFilters({ draft, patch }: FieldsProps) {
  const roles = useRoles();
  const types = useProductTypes();
  return (
    <>
      <Field id="filter-role" label={t('teams.filters.role')}>
        {(c) => (
          <select {...c} value={draft.role} onChange={(e) => patch({ role: e.target.value })}>
            <option value="">{t('teams.filters.any')}</option>
            {(roles.data ?? []).map((role) => (
              <option key={role.code} value={role.code}>
                {role.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field id="filter-type" label={t('teams.filters.productType')}>
        {(c) => (
          <select
            {...c}
            value={draft.productType}
            onChange={(e) => patch({ productType: e.target.value })}
          >
            <option value="">{t('teams.filters.any')}</option>
            {(types.data ?? []).map((type) => (
              <option key={type.code} value={type.code}>
                {type.name}
              </option>
            ))}
          </select>
        )}
      </Field>
    </>
  );
}

function StackAndStatus({ draft, patch }: FieldsProps) {
  return (
    <>
      <Field id="filter-stack" label={t('teams.filters.stack')} hint={t('teams.filters.stackHint')}>
        {(c) => (
          <input
            {...c}
            type="text"
            autoComplete="off"
            value={draft.stack}
            onChange={(e) => patch({ stack: e.target.value })}
          />
        )}
      </Field>
      <Field id="filter-status" label={t('teams.filters.status')}>
        {(c) => (
          <select
            {...c}
            value={draft.status}
            onChange={(e) => patch({ status: e.target.value as TeamFilters['status'] })}
          >
            <option value="">{t('teams.filters.any')}</option>
            <option value="forming">{t('teams.status.forming')}</option>
            <option value="active">{t('teams.status.active')}</option>
          </select>
        )}
      </Field>
    </>
  );
}

/** Filters of the team list; applied on submit so each change is one request, not one per key. */
export function TeamFiltersForm({ applied, onApply, count }: Props) {
  const [draft, setDraft] = useState(applied);
  const patch = (change: Partial<TeamFilters>) => setDraft((prev) => ({ ...prev, ...change }));
  function submit(event: FormEvent) {
    event.preventDefault();
    onApply({ ...draft, stack: draft.stack.trim() });
  }
  function reset() {
    setDraft(EMPTY_FILTERS);
    onApply(EMPTY_FILTERS);
  }
  return (
    <form onSubmit={submit} className="team-filters" aria-label={t('teams.filters.title')}>
      <div className="team-filter-fields">
        <CatalogFilters draft={draft} patch={patch} />
        <StackAndStatus draft={draft} patch={patch} />
      </div>
      <div className="row team-filter-actions">
        <button type="submit" className="button">
          {t('teams.filters.apply')}
        </button>
        <button type="button" className="button button-secondary" onClick={reset}>
          {t('teams.filters.reset')}
        </button>
        {count === undefined ? null : (
          <span className="mono muted team-count">{t('teams.list.count', { count })}</span>
        )}
      </div>
    </form>
  );
}
