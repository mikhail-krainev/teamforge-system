'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { useMe } from '@/features/auth/session';
import { useRoles } from '@/features/profile/useProfileQueries';
import { useTeam } from '@/features/teams/queries';
import { t } from '@/i18n';
import { ApiError } from '@/lib/api/errors';
import type { CatalogEntry } from '@/features/profile/api';
import type { SeatOffer } from './api';
import { ActionErrorAlert } from './ActionErrorAlert';
import { OfferComposer } from './OfferComposer';
import { useTeamOffers } from './queries';
import { useOfferActions } from './useOfferActions';

function TeamOfferRow({ offer, roleName }: { offer: SeatOffer; roleName: string }) {
  const { accept, reject, busy, refresh } = useOfferActions(offer);
  const request = offer.direction === 'user_to_lead';
  const pending = offer.status === 'pending';
  const error = accept.error ?? reject.error;
  return (
    <li className="card stack">
      <h3>{t(`offers.direction.${offer.direction}`)}</h3>
      <p className="muted">
        {[t('offers.mine.role', { role: roleName }), t(`offers.status.${offer.status}`)].join(
          ' · ',
        )}
      </p>
      <p>
        <Link href={`/users/${offer.userId}`}>
          {t('offers.team.candidate', { id: offer.userId })}
        </Link>
      </p>
      {offer.message ? <p className="pre-text">{offer.message}</p> : null}
      {accept.isSuccess ? <Alert tone="success">{t('offers.team.requestAccepted')}</Alert> : null}
      {error ? <ActionErrorAlert error={error} onRefresh={() => void refresh()} /> : null}
      {pending ? (
        <div className="row">
          {request ? (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => accept.mutate()}
            >
              {accept.isPending ? t('offers.team.working') : t('offers.team.acceptRequest')}
            </button>
          ) : null}
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => reject.mutate()}
          >
            {reject.isPending
              ? t('offers.team.working')
              : t(request ? 'offers.team.rejectRequest' : 'offers.team.withdraw')}
          </button>
        </div>
      ) : null}
    </li>
  );
}

function TeamOffersList({ teamId, roles }: { teamId: string; roles: readonly CatalogEntry[] }) {
  const offers = useTeamOffers(teamId);
  const items = offers.data?.pages.flatMap((page) => page.items) ?? [];
  const roleName = (code: string) => roles.find((r) => r.code === code)?.name ?? code;
  const forbidden =
    offers.error instanceof ApiError &&
    (offers.error.status === 403 || offers.error.status === 404);
  return (
    <section className="stack" aria-labelledby="team-offers-heading">
      <h2 id="team-offers-heading">{t('offers.team.listTitle')}</h2>
      {offers.isPending ? <p role="status">{t('offers.team.loading')}</p> : null}
      {forbidden ? <Alert tone="error">{t('offers.team.forbidden')}</Alert> : null}
      {offers.isError && !forbidden ? (
        <Alert tone="error">
          <p>{t('offers.team.loadFailed')}</p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void offers.refetch()}
          >
            {t('offers.retry')}
          </button>
        </Alert>
      ) : null}
      {offers.isSuccess && items.length === 0 ? (
        <p className="muted">{t('offers.team.empty')}</p>
      ) : null}
      {items.length > 0 ? (
        <ul className="stack">
          {items.map((offer) => (
            <TeamOfferRow key={offer.id} offer={offer} roleName={roleName(offer.roleCode)} />
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
    </section>
  );
}

export function TeamOffersPage({ teamId }: { teamId: string }) {
  const team = useTeam(teamId);
  const me = useMe();
  const roles = useRoles();
  const isLead = Boolean(team.data && me.data && team.data.leadUserId === me.data.id);
  return (
    <div className="stack">
      <h1>{t('offers.team.title')}</h1>
      <p>
        <Link href={`/teams/${teamId}`}>{t('offers.team.back')}</Link>
      </p>
      {isLead && team.data ? (
        <OfferComposer teamId={teamId} seats={team.data.seats} roles={roles.data ?? []} />
      ) : null}
      <TeamOffersList teamId={teamId} roles={roles.data ?? []} />
    </div>
  );
}
