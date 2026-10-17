'use client';

import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Alert } from '@/components/ui/Alert';
import { useMe } from '@/features/auth/session';
import { useTeamChannel } from '@/features/notifications/RealtimeProvider';
import { ActionErrorAlert } from '@/features/offers/ActionErrorAlert';
import { createOffer, teamOffersKey } from '@/features/offers/api';
import { useRoles } from '@/features/profile/useProfileQueries';
import { useTeam } from '@/features/teams/queries';
import { t } from '@/i18n';
import { ApiError } from '@/lib/api/errors';
import { useIdempotentMutation } from '@/lib/api/idempotency';
import type { CandidateRecommendation } from './api';
import { MatchExplanation } from './MatchExplanation';
import { useSeatCandidates } from './queries';

interface ItemProps {
  teamId: string;
  seatId: string;
  item: CandidateRecommendation;
}

function CandidateItem({ teamId, seatId, item }: ItemProps) {
  const queryClient = useQueryClient();
  const offer = useIdempotentMutation({
    mutationFn: (_: void, key) => createOffer(teamId, { seatId, userId: item.userId }, key),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: teamOffersKey(teamId) }),
  });
  return (
    <li className="card stack">
      <h3>
        <Link href={`/users/${item.userId}`}>{item.displayName}</Link>
        {item.inQueue ? <span className="tag">{t('matching.candidates.inQueue')}</span> : null}
      </h3>
      <MatchExplanation score={item.score} reasons={item.reasons} />
      {offer.isError ? <ActionErrorAlert error={offer.error} /> : null}
      {offer.isSuccess ? (
        <Alert tone="success">{t('matching.candidates.offered')}</Alert>
      ) : (
        <div>
          <button
            type="button"
            className="button"
            disabled={offer.isPending}
            aria-label={`${t('matching.candidates.offer')}: ${item.displayName}`}
            onClick={() => offer.mutate()}
          >
            {offer.isPending ? t('matching.candidates.offering') : t('matching.candidates.offer')}
          </button>
        </div>
      )}
    </li>
  );
}

function CandidateList({ teamId, seatId }: { teamId: string; seatId: string }) {
  const query = useSeatCandidates(teamId, seatId, true);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  if (query.isPending) return <p role="status">{t('matching.candidates.loading')}</p>;
  if (query.isError) {
    return (
      <Alert tone="error">
        <p>{t('matching.candidates.loadFailed')}</p>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void query.refetch()}
        >
          {t('matching.retry')}
        </button>
      </Alert>
    );
  }
  if (items.length === 0) return <p className="muted">{t('matching.candidates.empty')}</p>;
  return (
    <>
      <ul className="stack" aria-label={t('matching.candidates.list')}>
        {items.map((item) => (
          <CandidateItem key={item.userId} teamId={teamId} seatId={seatId} item={item} />
        ))}
      </ul>
      {query.hasNextPage ? (
        <div>
          <button
            type="button"
            className="button button-secondary"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {t('matching.candidates.loadMore')}
          </button>
        </div>
      ) : null}
    </>
  );
}

/** `/teams/[id]/seats/[seatId]`: recommended candidates for one open seat, for the lead. */
export function SeatCandidatesPage({ teamId, seatId }: { teamId: string; seatId: string }) {
  const team = useTeam(teamId);
  const me = useMe();
  const roles = useRoles();
  useTeamChannel(teamId);

  const back = (
    <p>
      <Link href={`/teams/${teamId}/seats`}>{t('matching.candidates.back')}</Link>
    </p>
  );
  let body;
  if (team.isError) {
    const missing = team.error instanceof ApiError && team.error.status === 404;
    body = (
      <Alert tone="error">
        {missing ? t('teams.detail.notFound') : t('matching.candidates.teamFailed')}
      </Alert>
    );
  } else if (team.isPending || me.isPending) {
    body = <p role="status">{t('matching.candidates.loading')}</p>;
  } else if (!me.data || team.data.leadUserId !== me.data.id) {
    body = <Alert tone="error">{t('matching.candidates.leadOnly')}</Alert>;
  } else {
    const seat = team.data.seats.find((s) => s.id === seatId);
    const roleName = roles.data?.find((r) => r.code === seat?.roleCode)?.name ?? seat?.roleCode;
    if (!seat) body = <Alert tone="error">{t('matching.candidates.seatMissing')}</Alert>;
    else {
      body = (
        <>
          <p className="muted">
            {t('matching.candidates.seatInfo', { n: seat.ordinal, role: roleName ?? '' })}
          </p>
          {seat.status === 'open' ? (
            <CandidateList teamId={teamId} seatId={seatId} />
          ) : (
            <Alert tone="info">{t('matching.candidates.seatClosed')}</Alert>
          )}
        </>
      );
    }
  }
  return (
    <div className="stack">
      <h1>{t('matching.candidates.title')}</h1>
      {back}
      {body}
    </div>
  );
}
