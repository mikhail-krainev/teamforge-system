import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';

export type SeatOffer = Schema<'SeatOffer'>;
export type SeatOfferCreate = Schema<'SeatOfferCreate'>;
export type JoinRequestCreate = Schema<'JoinRequestCreate'>;
export type JoinResult = Schema<'JoinResult'>;
export type Departure = Schema<'Departure'>;
export type DepartureDecision = Schema<'DepartureDecision'>;

type Client = typeof apiClient;

export const OFFERS_PAGE = 20;
export const MY_OFFERS_KEY = ['offers', 'mine'] as const;
export const teamOffersKey = (teamId: string) => ['offers', 'team', teamId] as const;
export const departuresKey = (teamId: string) => ['teams', 'departures', teamId] as const;

export async function fetchMyOffers(
  cursor: string | undefined,
  client: Pick<Client, 'GET'> = apiClient,
) {
  const { data } = await client.GET('/v1/me/seat-offers', {
    params: { query: { limit: OFFERS_PAGE, ...(cursor ? { cursor } : {}) } },
  });
  if (!data) throw new Error('Empty offers response');
  return data;
}

export async function fetchTeamOffers(
  teamId: string,
  cursor: string | undefined,
  client: Pick<Client, 'GET'> = apiClient,
) {
  const { data } = await client.GET('/v1/teams/{teamId}/seat-offers', {
    params: { path: { teamId }, query: { limit: OFFERS_PAGE, ...(cursor ? { cursor } : {}) } },
  });
  if (!data) throw new Error('Empty offers response');
  return data;
}

export async function createOffer(
  teamId: string,
  body: SeatOfferCreate,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/teams/{teamId}/seat-offers', {
    body,
    params: { path: { teamId }, header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty offer response');
  return data;
}

export async function createJoinRequest(
  teamId: string,
  body: JoinRequestCreate,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/teams/{teamId}/join-requests', {
    body,
    params: { path: { teamId }, header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty request response');
  return data;
}

export async function acceptOffer(
  offerId: string,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/seat-offers/{offerId}/acceptance', {
    params: { path: { offerId }, header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty join response');
  return data;
}

export async function rejectOffer(
  offerId: string,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/seat-offers/{offerId}/rejection', {
    params: { path: { offerId }, header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty offer response');
  return data;
}

export async function leaveTeam(
  teamId: string,
  key: string,
  client: Pick<Client, 'DELETE'> = apiClient,
) {
  await client.DELETE('/v1/teams/{teamId}/members/me', {
    params: { path: { teamId }, header: { 'Idempotency-Key': key } },
  });
}

export async function fetchDepartures(teamId: string, client: Pick<Client, 'GET'> = apiClient) {
  const { data } = await client.GET('/v1/teams/{teamId}/departures', {
    params: { path: { teamId }, query: { limit: OFFERS_PAGE } },
  });
  if (!data) throw new Error('Empty departures response');
  return data.items;
}

export async function decideDeparture(
  teamId: string,
  departureId: string,
  body: DepartureDecision,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/teams/{teamId}/departures/{departureId}/decision', {
    body,
    params: { path: { teamId, departureId }, header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty departure response');
  return data;
}
