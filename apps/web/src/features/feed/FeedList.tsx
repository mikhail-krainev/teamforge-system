'use client';

import Link from 'next/link';
import { Yeti } from '@/components/mascot/Yeti';
import { Alert } from '@/components/ui/Alert';
import { t } from '@/i18n';
import { FeedEntryItem, type EntryContext } from './FeedEntryItem';
import type { FeedFilters } from './api';
import { useFeed } from './queries';
import { useLoadMoreOnScroll } from './useLoadMoreOnScroll';

type FeedQuery = ReturnType<typeof useFeed>;

function EmptyFeed({ teamId, isFiltered }: { teamId: string; isFiltered: boolean }) {
  if (isFiltered) return <p className="muted">{t('feed.emptyFiltered')}</p>;
  return (
    <div className="empty">
      <Yeti pose="sleep" size={96} />
      <div className="stack">
        <p className="muted">{t('feed.empty')}</p>
        <p>
          <Link href={`/teams/${teamId}/github`}>{t('feed.toGithub')}</Link>
        </p>
      </div>
    </div>
  );
}

function FeedLoading() {
  return (
    <div className="row">
      <Yeti pose="think" size={96} />
      <p role="status">{t('feed.loading')}</p>
    </div>
  );
}

function MoreEntries({ feed }: { feed: FeedQuery }) {
  const sentinel = useLoadMoreOnScroll({
    enabled: feed.hasNextPage && !feed.isFetchingNextPage && !feed.isFetchNextPageError,
    onLoadMore: () => void feed.fetchNextPage(),
  });
  return (
    <div ref={sentinel} className="stack">
      {feed.isFetchNextPageError ? <Alert tone="error">{t('feed.more.failed')}</Alert> : null}
      {feed.hasNextPage ? (
        <div>
          <button
            type="button"
            className="button button-secondary"
            disabled={feed.isFetchingNextPage}
            onClick={() => void feed.fetchNextPage()}
          >
            {feed.isFetchingNextPage ? t('feed.more.loading') : t('feed.more.button')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The records of the feed with the loading, empty and failed states and the cursor paging. */
export function FeedList({
  teamId,
  filters,
  context,
}: {
  teamId: string;
  filters: FeedFilters;
  context: EntryContext;
}) {
  const feed = useFeed(teamId, filters);
  const entries = feed.data?.pages.flatMap((page) => page.items) ?? [];
  const isFiltered = filters.userId !== '' || filters.source !== '';
  if (feed.isPending) return <FeedLoading />;
  if (feed.isError && !feed.data) {
    return (
      <Alert tone="error">
        <p>{t('feed.loadFailed')}</p>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void feed.refetch()}
        >
          {t('feed.retry')}
        </button>
      </Alert>
    );
  }
  return (
    <div className="stack">
      <p role="status" className="sr-only">
        {t('feed.loaded', { count: entries.length })}
      </p>
      {entries.length === 0 ? <EmptyFeed teamId={teamId} isFiltered={isFiltered} /> : null}
      {entries.length > 0 ? (
        <ul className="feed-log" aria-label={t('feed.list')}>
          {entries.map((entry) => (
            <FeedEntryItem key={entry.id} entry={entry} context={context} />
          ))}
        </ul>
      ) : null}
      <MoreEntries feed={feed} />
    </div>
  );
}
