import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';

export type FeedEntry = Schema<'FeedEntry'>;
export type FeedSource = FeedEntry['source'];

type Client = typeof apiClient;

export const FEED_PAGE_SIZE = 20;
export const FEED_SOURCES: readonly FeedSource[] = ['issue', 'pr', 'artifact', 'ritual'];

/** Empty string means "no filter". */
export interface FeedFilters {
  userId: string;
  source: '' | FeedSource;
}

export const EMPTY_FEED_FILTERS: FeedFilters = { userId: '', source: '' };

export { feedRootKey } from '@/features/contribution/api';
export const feedListKey = (teamId: string, filters: FeedFilters) =>
  ['feed', teamId, 'list', filters] as const;

export async function fetchFeedPage(
  teamId: string,
  filters: FeedFilters,
  cursor: string | undefined,
  client: Pick<Client, 'GET'> = apiClient,
) {
  const query = {
    limit: FEED_PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...(filters.source ? { source: filters.source } : {}),
  };
  const { data } = await client.GET('/v1/teams/{teamId}/feed', {
    params: { path: { teamId }, query },
  });
  if (!data) throw new Error('Empty feed response');
  return data;
}
