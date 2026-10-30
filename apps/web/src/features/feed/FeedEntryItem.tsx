'use client';

import { RelabelControl } from '@/features/contribution/RelabelControl';
import type { NameOf, RoleNameOf } from '@/features/contribution/model';
import { formatDate } from '@/features/route/model';
import { t } from '@/i18n';
import type { FeedEntry } from './api';
import './feed.css';

export interface EntryContext {
  teamId: string;
  nameOf: NameOf;
  roleName: RoleNameOf;
  /** Who is looking, and the roles that person holds in the team (empty for an observer). */
  meId: string | undefined;
  myRoleCodes: readonly string[];
  /** The roles can still be relabelled (before completion, FR-WORK-17). */
  canRelabel: boolean;
}

function EntryTitle({ entry }: { entry: FeedEntry }) {
  // The title and the address come from GitHub or from members: text only, and only https is a link.
  if (entry.url?.startsWith('https://')) {
    return (
      <a href={entry.url} target="_blank" rel="noopener noreferrer">
        {entry.title}
        <span className="sr-only"> ({t('feed.entry.open')})</span>
      </a>
    );
  }
  return <>{entry.title}</>;
}

/** One record of the feed: what, who, in which role, when; the author may relabel the role. */
export function FeedEntryItem({ entry, context }: { entry: FeedEntry; context: EntryContext }) {
  const isMine = context.meId !== undefined && entry.userId === context.meId;
  const meta = [
    t(`feed.source.${entry.source}`),
    t('feed.entry.occurred', { date: formatDate(entry.occurredAt) }),
    ...(entry.stageOrdinal !== null && entry.stageOrdinal !== undefined
      ? [t('feed.entry.stage', { ordinal: entry.stageOrdinal })]
      : []),
  ].join(' · ');
  return (
    <li className="feed-entry">
      <h3>
        <EntryTitle entry={entry} />
      </h3>
      <p className="mono muted">{meta}</p>
      <p>
        {t('feed.entry.executor', { name: context.nameOf(entry.userId) })}
        {' · '}
        {t('feed.entry.role', { role: context.roleName(entry.roleCode) })}
      </p>
      {entry.active ? null : <p className="muted">{t('feed.entry.inactive')}</p>}
      {isMine && entry.active && context.canRelabel ? (
        <RelabelControl
          teamId={context.teamId}
          entry={entry}
          roleCodes={context.myRoleCodes}
          roleName={context.roleName}
        />
      ) : null}
    </li>
  );
}
