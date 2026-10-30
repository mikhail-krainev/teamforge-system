'use client';

import Link from 'next/link';
import { Yeti } from '@/components/mascot/Yeti';
import { Alert } from '@/components/ui/Alert';
import { PageHead } from '@/components/ui/PageHead';
import { useRoles } from '@/features/profile/useProfileQueries';
import { t } from '@/i18n';
import type { SeatOffer } from './api';
import { ActionErrorAlert } from './ActionErrorAlert';
import { useMyOffers } from './queries';
import { useOfferActions } from './useOfferActions';

function OfferMeta({ offer, roleName }: { offer: SeatOffer; roleName: string }) {
  return (
    <>
      <h2>{t(`offers.direction.${offer.direction}`)}</h2>
      <p className="muted">
        {[
          t('offers.mine.role', { role: roleName }),
          t(`offers.status.${offer.status}`),
          t('offers.mine.expires', {
            date: new Date(offer.expiresAt).toLocaleDateString('ru-RU'),
          }),
        ].join(' · ')}
      </p>
      {offer.message ? (
        <p className="pre-text">{t('offers.mine.message', { message: offer.message })}</p>
      ) : null}
    </>
  );
}

function OfferCard({ offer, roleName }: { offer: SeatOffer; roleName: string }) {
  const { accept, reject, busy, refresh } = useOfferActions(offer);
  const incoming = offer.direction === 'lead_to_user';
  const pending = offer.status === 'pending';
  const error = accept.error ?? reject.error;
  return (
    <li className="card stack">
      <OfferMeta offer={offer} roleName={roleName} />
      {accept.isSuccess ? <Alert tone="success">{t('offers.mine.joined')}</Alert> : null}
      {reject.isSuccess ? (
        <Alert tone="success">
          {t(incoming ? 'offers.mine.rejectedDone' : 'offers.mine.withdrawnDone')}
        </Alert>
      ) : null}
      {error ? <ActionErrorAlert error={error} onRefresh={() => void refresh()} /> : null}
      <div className="row">
        {pending && incoming ? (
          <button type="button" className="button" disabled={busy} onClick={() => accept.mutate()}>
            {accept.isPending ? t('offers.mine.accepting') : t('offers.mine.accept')}
          </button>
        ) : null}
        {pending ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => reject.mutate()}
          >
            {reject.isPending
              ? t(incoming ? 'offers.mine.rejecting' : 'offers.mine.withdrawing')
              : t(incoming ? 'offers.mine.reject' : 'offers.mine.withdraw')}
          </button>
        ) : null}
        <Link href={`/teams/${offer.teamId}`} className="button button-secondary">
          {t('offers.mine.team')}
        </Link>
      </div>
    </li>
  );
}

function EmptyOffers() {
  return (
    <div className="empty">
      <Yeti pose="sleep" size={96} />
      <div className="stack">
        <p>{t('offers.mine.empty')}</p>
        <p className="muted">{t('offers.mine.emptyHint')}</p>
        <Link href="/profile" className="text-link">
          {t('offers.mine.emptyLink')}
        </Link>
      </div>
    </div>
  );
}

function LoadingOffers() {
  return (
    <div className="row">
      <Yeti pose="think" size={96} />
      <p role="status">{t('offers.mine.loading')}</p>
    </div>
  );
}

export function MyOffersPage() {
  const offers = useMyOffers();
  const roles = useRoles();
  const items = offers.data?.pages.flatMap((page) => page.items) ?? [];
  const roleName = (code: string) => roles.data?.find((r) => r.code === code)?.name ?? code;
  return (
    <div className="stack">
      <PageHead title={t('offers.mine.title')} lead={t('offers.mine.lead')} />
      {offers.isPending ? <LoadingOffers /> : null}
      {offers.isError ? (
        <Alert tone="error">
          <p>{t('offers.mine.loadFailed')}</p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void offers.refetch()}
          >
            {t('offers.retry')}
          </button>
        </Alert>
      ) : null}
      {offers.isSuccess && items.length === 0 ? <EmptyOffers /> : null}
      {items.length > 0 ? (
        <ul className="stack" aria-label={t('offers.mine.title')}>
          {items.map((offer) => (
            <OfferCard key={offer.id} offer={offer} roleName={roleName(offer.roleCode)} />
          ))}
        </ul>
      ) : null}
      {offers.hasNextPage ? (
        <div>
          <button
            type="button"
            className="button button-secondary"
            disabled={offers.isFetchingNextPage}
            onClick={() => void offers.fetchNextPage()}
          >
            {t('offers.mine.loadMore')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
