import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';

export type Team = Schema<'Team'>;
export type TeamSummary = Schema<'TeamSummary'>;
export type TeamCreate = Schema<'TeamCreate'>;
export type TeamPatch = Schema<'TeamPatch'>;
export type Seat = Schema<'Seat'>;
export type SeatInput = Schema<'SeatInput'>;
export type SeatPatch = Schema<'SeatPatch'>;
export type Member = Schema<'Member'>;
export type TeamEvent = Schema<'TeamEvent'>;
export type ProductType = Schema<'ProductType'>;
export type Level = Schema<'Level'>;

type Client = typeof apiClient;

export const PAGE_SIZE = 20;
export const PRODUCT_TYPES_KEY = ['catalog', 'product-types'] as const;
export const teamKey = (id: string) => ['teams', 'detail', id] as const;
export const teamEventsKey = (id: string) => ['teams', 'events', id] as const;
export const teamsListKey = (filters: TeamFilters) => ['teams', 'list', filters] as const;

export interface TeamFilters {
  role: string;
  stack: string;
  productType: string;
  status: '' | 'forming' | 'active';
}

export const EMPTY_FILTERS: TeamFilters = { role: '', stack: '', productType: '', status: '' };

export async function fetchTeamsPage(
  filters: TeamFilters,
  cursor: string | undefined,
  client: Pick<Client, 'GET'> = apiClient,
) {
  const query = {
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
    ...(filters.role ? { role: filters.role } : {}),
    ...(filters.stack ? { stack: filters.stack } : {}),
    ...(filters.productType ? { productType: filters.productType } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };
  const { data } = await client.GET('/v1/teams', { params: { query } });
  if (!data) throw new Error('Empty teams response');
  return data;
}

export async function fetchProductTypes(client: Pick<Client, 'GET'> = apiClient) {
  const { data } = await client.GET('/v1/product-types');
  return data?.items ?? [];
}

export async function fetchTeam(teamId: string, client: Pick<Client, 'GET'> = apiClient) {
  const { data } = await client.GET('/v1/teams/{teamId}', { params: { path: { teamId } } });
  if (!data) throw new Error('Empty team response');
  return data;
}

export async function fetchTeamEvents(
  teamId: string,
  cursor: string | undefined,
  client: Pick<Client, 'GET'> = apiClient,
) {
  const { data } = await client.GET('/v1/teams/{teamId}/events', {
    params: { path: { teamId }, query: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) } },
  });
  if (!data) throw new Error('Empty events response');
  return data;
}

export async function createTeam(
  body: TeamCreate,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/teams', {
    body,
    params: { header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty team response');
  return data;
}

export async function addSeats(
  teamId: string,
  seats: SeatInput[],
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/teams/{teamId}/seats', {
    body: { seats },
    params: { path: { teamId }, header: { 'Idempotency-Key': key } },
  });
  return data?.items ?? [];
}

export async function updateSeat(
  teamId: string,
  seatId: string,
  body: SeatPatch,
  key: string,
  client: Pick<Client, 'PATCH'> = apiClient,
) {
  const { data } = await client.PATCH('/v1/teams/{teamId}/seats/{seatId}', {
    body,
    params: { path: { teamId, seatId }, header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty seat response');
  return data;
}

export async function closeSeat(
  teamId: string,
  seatId: string,
  key: string,
  client: Pick<Client, 'DELETE'> = apiClient,
) {
  await client.DELETE('/v1/teams/{teamId}/seats/{seatId}', {
    params: { path: { teamId, seatId }, header: { 'Idempotency-Key': key } },
  });
}
