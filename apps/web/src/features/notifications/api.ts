import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';

export type Notification = Schema<'Notification'>;

type Client = typeof apiClient;

export const NOTIFICATIONS_PAGE = 20;
/** Unread badge: one page of 100 is enough to show "99+". */
export const UNREAD_LIMIT = 100;
export const NOTIFICATIONS_ROOT = ['notifications'] as const;
export const NOTIFICATIONS_LIST_KEY = ['notifications', 'list'] as const;
export const NOTIFICATIONS_UNREAD_KEY = ['notifications', 'unread'] as const;

export async function fetchNotifications(
  cursor: string | undefined,
  client: Pick<Client, 'GET'> = apiClient,
) {
  const { data } = await client.GET('/v1/me/notifications', {
    params: { query: { limit: NOTIFICATIONS_PAGE, ...(cursor ? { cursor } : {}) } },
  });
  if (!data) throw new Error('Empty notifications response');
  return data;
}

/** Number of unread notifications, capped at `UNREAD_LIMIT` (`capped` says there are more). */
export async function fetchUnreadCount(client: Pick<Client, 'GET'> = apiClient) {
  const { data } = await client.GET('/v1/me/notifications', {
    params: { query: { limit: UNREAD_LIMIT, unread: true } },
  });
  if (!data) throw new Error('Empty notifications response');
  return { count: data.items.length, capped: data.nextCursor !== null };
}

export async function markRead(
  ids: readonly string[],
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  await client.POST('/v1/me/notifications/read-marks', {
    body: { ids: [...ids] },
    params: { header: { 'Idempotency-Key': key } },
  });
}
