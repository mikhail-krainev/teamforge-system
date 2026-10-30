'use client';

import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Yeti } from '@/components/mascot/Yeti';
import { Alert } from '@/components/ui/Alert';
import { ActionErrorAlert } from '@/features/offers/ActionErrorAlert';
import { createJoinRequest, MY_OFFERS_KEY } from '@/features/offers/api';
import type { CatalogEntry } from '@/features/profile/api';
import { t } from '@/i18n';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import type { TeamRecommendation } from './api';
import '@/features/matching/matching.css';
import { MatchExplanation } from './MatchExplanation';
import { useRecommendedTeams } from './queries';

function TeamItem({ item, roleName }: { item: TeamRecommendation; roleName: string }) {
  const queryClient = useQueryClient();
  const apply = useIdempotentMutation({
    mutationFn: (_: void, key) => createJoinRequest(item.teamId, { seatId: item.seatId }, key),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MY_OFFERS_KEY }),
  });
  return (
    <li className="rec-row">
      <h3>
        <Link href={`/teams/${item.teamId}`}>{item.teamName}</Link>
      </h3>
      <p className="muted">{t('matching.recs.role', { role: roleName })}</p>
      <MatchExplanation score={item.score} reasons={item.reasons} />
      {apply.isError ? <ActionErrorAlert error={apply.error} /> : null}
      {apply.isSuccess ? (
        <Alert tone="success">
          {t('matching.recs.applied')} <Link href="/offers">{t('matching.recs.myOffers')}</Link>
        </Alert>
      ) : (
        <div>
          <button
            type="button"
            className="button"
            disabled={apply.isPending}
            aria-label={`${t('matching.recs.apply')}: ${item.teamName}`}
            onClick={() => apply.mutate()}
          >
            {apply.isPending ? t('matching.recs.applying') : t('matching.recs.apply')}
          </button>
        </div>
      )}
    </li>
  );
}

function EmptyRecs() {
  return (
    <div className="empty">
      <Yeti pose="sleep" size={96} />
      <p className="muted">{t('matching.recs.empty')}</p>
    </div>
  );
}

/** "Рекомендованные команды": best open seats for the caller with the match explanation. */
export function RecommendedTeams({ roles }: { roles: readonly CatalogEntry[] }) {
  const query = useRecommendedTeams();
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="stack" aria-labelledby="recommended-teams-heading">
      <h2 id="recommended-teams-heading">{t('matching.recs.title')}</h2>
      <p className="muted">{t('matching.recs.lead')}</p>
      {query.isPending ? <p role="status">{t('matching.recs.loading')}</p> : null}
      {query.isError ? (
        <Alert tone="error">
          <p>{t('matching.recs.loadFailed')}</p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void query.refetch()}
          >
            {t('matching.retry')}
          </button>
        </Alert>
      ) : null}
      {query.isSuccess && items.length === 0 ? <EmptyRecs /> : null}
      {items.length > 0 ? (
        <ul className="team-list" aria-label={t('matching.recs.list')}>
          {items.map((item) => (
            <TeamItem
              key={`${item.teamId}:${item.seatId}`}
              item={item}
              roleName={roles.find((r) => r.code === item.roleCode)?.name ?? item.roleCode}
            />
          ))}
        </ul>
      ) : null}
      {query.hasNextPage ? (
        <div>
          <button
            type="button"
            className="button button-secondary"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {t('matching.recs.loadMore')}
          </button>
        </div>
      ) : null}
    </section>
  );
}
