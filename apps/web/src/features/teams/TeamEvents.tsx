'use client';

import { Alert } from '@/components/ui/Alert';
import { hasMessage, t } from '@/i18n';
import type { Member, TeamEvent } from './api';
import { useTeamEvents } from './queries';

/** Known event types have a Russian title; an unknown one is shown by its code (escaped by React). */
export function eventTitle(type: string): string {
  const key = `teams.events.types.${type.replaceAll('.', '_')}`;
  return hasMessage(key) ? t(key) : t('teams.events.unknown', { type });
}

function EventItem({ event, members }: { event: TeamEvent; members: readonly Member[] }) {
  const actor = members.find((m) => m.userId === event.actorUserId)?.displayName;
  return (
    <li className="card nested">
      <p>
        <strong>{eventTitle(event.type)}</strong>
      </p>
      <p className="muted">
        <time dateTime={event.at}>{new Date(event.at).toLocaleString('ru-RU')}</time>
        {actor ? ` · ${actor}` : ''}
      </p>
    </li>
  );
}

export function TeamEvents({ teamId, members }: { teamId: string; members: readonly Member[] }) {
  const events = useTeamEvents(teamId);
  const items = events.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="stack" aria-labelledby="team-events-heading">
      <h2 id="team-events-heading">{t('teams.events.title')}</h2>
      {events.isPending ? <p role="status">{t('teams.events.loading')}</p> : null}
      {events.isError ? (
        <Alert tone="error">
          <p>{t('teams.events.loadFailed')}</p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => events.refetch()}
          >
            {t('teams.retry')}
          </button>
        </Alert>
      ) : null}
      {events.isSuccess && items.length === 0 ? (
        <p className="muted">{t('teams.events.empty')}</p>
      ) : null}
      {items.length > 0 ? (
        <ul className="stack">
          {items.map((event) => (
            <EventItem key={event.id} event={event} members={members} />
          ))}
        </ul>
      ) : null}
      {events.hasNextPage ? (
        <div>
          <button
            type="button"
            className="button button-secondary"
            disabled={events.isFetchingNextPage}
            onClick={() => events.fetchNextPage()}
          >
            {events.isFetchingNextPage ? t('teams.list.loadingMore') : t('teams.list.loadMore')}
          </button>
        </div>
      ) : null}
    </section>
  );
}
