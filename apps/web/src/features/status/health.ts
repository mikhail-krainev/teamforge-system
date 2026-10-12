import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import type { MessageKey } from '@/i18n';

export type Health = Schema<'Health'>;
export type ApiStatus = 'checking' | 'ok' | 'degraded' | 'unavailable';

function isHealth(body: unknown): body is Health {
  if (typeof body !== 'object' || body === null) return false;
  const status = (body as { status?: unknown }).status;
  return status === 'ok' || status === 'degraded' || status === 'down';
}

/** `healthReady`; a 503 still carries a `Health` body that tells what is degraded. */
export async function fetchHealth(client: Pick<typeof apiClient, 'GET'> = apiClient): Promise<Health> {
  try {
    const { data } = await client.GET('/health/ready');
    if (data) return data;
  } catch (error) {
    if (error instanceof ApiError && isHealth(error.body)) return error.body;
    throw error;
  }
  throw new Error('Empty health response');
}

export function toApiStatus(health: Health | undefined, failed: boolean): ApiStatus {
  if (failed) return 'unavailable';
  if (!health) return 'checking';
  if (health.status === 'ok') return 'ok';
  return health.status === 'degraded' ? 'degraded' : 'unavailable';
}

export const STATUS_MESSAGES: Record<ApiStatus, { title: MessageKey; hint: MessageKey }> = {
  checking: { title: 'status.checking', hint: 'status.checkingHint' },
  ok: { title: 'status.ok', hint: 'status.okHint' },
  degraded: { title: 'status.degraded', hint: 'status.degradedHint' },
  unavailable: { title: 'status.unavailable', hint: 'status.unavailableHint' },
};
