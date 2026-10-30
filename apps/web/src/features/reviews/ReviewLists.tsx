'use client';

import { Yeti } from '@/components/mascot/Yeti';
import { Alert } from '@/components/ui/Alert';
import { t } from '@/i18n';
import { describeError } from '@/lib/api/error-message';
import type { ReceivedReview, ReviewSentList } from './api';
import './reviews.css';
import { formatDay } from './model';
import { useReceivedReviews } from './queries';

function LoadFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Alert tone="error">
      <p>{t('reviews.loadFailed')}</p>
      <p className="muted">{describeError(error)}</p>
      <button type="button" className="button button-secondary" onClick={onRetry}>
        {t('reviews.retry')}
      </button>
    </Alert>
  );
}

function ReviewItems({ items }: { items: readonly ReceivedReview[] }) {
  return (
    <ul className="review-wall plain-list">
      {items.map((item) => (
        <li key={item.id} className="scallop">
          <p className="review-text">{item.text}</p>
          <p className="mono">
            {t('reviews.received.published', { date: formatDay(item.publishedOn) })}
            {' / '}
            {t('reviews.received.team', { team: item.teamName })}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Received reviews: no author, only the day of the batch (SEC-04). */
export function ReceivedReviews() {
  const query = useReceivedReviews();
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="stack" aria-labelledby="reviews-received">
      <h2 id="reviews-received">{t('reviews.received.title')}</h2>
      {query.isPending ? <p role="status">{t('reviews.loading')}</p> : null}
      {query.isError ? (
        <LoadFailure error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {query.isSuccess && items.length === 0 ? (
        <div className="empty">
          <Yeti pose="sleep" size={96} />
          <div className="stack">
            <p>{t('reviews.received.empty')}</p>
            <p className="muted">{t('reviews.received.emptyHint')}</p>
          </div>
        </div>
      ) : null}
      {items.length > 0 ? <ReviewItems items={items} /> : null}
      {query.hasNextPage ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage
            ? t('reviews.received.loadingMore')
            : t('reviews.received.more')}
        </button>
      ) : null}
    </section>
  );
}

/** The colleagues the user has already written to in the project; never the texts. */
export function SentReviews({
  sent,
  nameOf,
}: {
  sent: ReviewSentList | null | undefined;
  nameOf: (userId: string) => string;
}) {
  return (
    <section className="stack" aria-labelledby="reviews-sent">
      <h2 id="reviews-sent">{t('reviews.sent.title')}</h2>
      {sent && sent.items.length > 0 ? (
        <ul className="stack plain-list">
          {sent.items.map((item) => (
            <li key={item.subjectUserId}>
              {t('reviews.sent.item', { name: nameOf(item.subjectUserId) })}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t('reviews.sent.empty')}</p>
      )}
    </section>
  );
}
