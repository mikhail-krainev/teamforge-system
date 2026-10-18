'use client';

import { useId } from 'react';
import { Field } from '@/components/ui/Field';
import { t } from '@/i18n';
import type { Member } from '@/features/teams/api';
import {
  EMPTY_FEED_FILTERS,
  FEED_SOURCES,
  type FeedFilters as Filters,
  type FeedSource,
} from './api';

interface Props {
  filters: Filters;
  members: readonly Pick<Member, 'userId' | 'displayName'>[];
  onChange: (filters: Filters) => void;
}

function isFeedSource(value: string): value is FeedSource {
  return (FEED_SOURCES as readonly string[]).includes(value);
}

function SourceField({
  id,
  filters,
  onChange,
}: {
  id: string;
  filters: Filters;
  onChange: (filters: Filters) => void;
}) {
  return (
    <Field id={id} label={t('feed.filters.source')}>
      {(control) => (
        <select
          {...control}
          value={filters.source}
          onChange={(event) =>
            onChange({
              ...filters,
              source: isFeedSource(event.target.value) ? event.target.value : '',
            })
          }
        >
          <option value="">{t('feed.filters.sourceAll')}</option>
          {FEED_SOURCES.map((source) => (
            <option key={source} value={source}>
              {t(`feed.source.${source}`)}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** Filters by executor and source; they apply at once (the list is re-read from the first page). */
export function FeedFilters({ filters, members, onChange }: Props) {
  const id = useId();
  const isFiltered = filters.userId !== '' || filters.source !== '';
  return (
    <form
      className="row"
      role="search"
      aria-label={t('feed.filters.title')}
      onSubmit={(event) => event.preventDefault()}
    >
      <Field id={`${id}-executor`} label={t('feed.filters.executor')}>
        {(control) => (
          <select
            {...control}
            value={filters.userId}
            onChange={(event) => onChange({ ...filters, userId: event.target.value })}
          >
            <option value="">{t('feed.filters.executorAll')}</option>
            {members.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.displayName}
              </option>
            ))}
          </select>
        )}
      </Field>
      <SourceField id={`${id}-source`} filters={filters} onChange={onChange} />
      {isFiltered ? (
        <button
          type="button"
          className="button button-secondary"
          onClick={() => onChange(EMPTY_FEED_FILTERS)}
        >
          {t('feed.filters.reset')}
        </button>
      ) : null}
    </form>
  );
}
