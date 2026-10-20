import type { Body } from 'shared';
import { apiClient } from '@/lib/api/client';
import type { ChecklistItem } from '@/features/route/api';

type Client = typeof apiClient;

export type ItemPatch = Omit<Body<'updateChecklistItem'>, 'version'>;
export type ReviewAnswers = Body<'submitReview'>['answers'];

/**
 * One write to a checklist item, as plain data: it is what the idempotency key is derived from,
 * and what "apply my changes again" re-sends against the actual version after a conflict.
 */
export type ItemWrite =
  | { kind: 'patch'; patch: ItemPatch }
  | { kind: 'assign'; userId: string }
  | { kind: 'revertFallback' }
  | { kind: 'review'; answers: ReviewAnswers }
  | { kind: 'risk'; ordinal: number; reason: string };

interface Target {
  teamId: string;
  itemId: string;
}

async function expectItem(data: ChecklistItem | undefined): Promise<ChecklistItem> {
  if (!data) throw new Error('Empty checklist item response');
  return data;
}

/** Runs one write with the given item version and idempotency key; every write returns the item. */
export async function runItemWrite(
  target: Target,
  write: ItemWrite,
  version: number,
  key: string,
  client: Pick<Client, 'PATCH' | 'PUT' | 'POST'> = apiClient,
): Promise<ChecklistItem> {
  const path = { teamId: target.teamId, itemId: target.itemId };
  const header = { 'Idempotency-Key': key };
  switch (write.kind) {
    case 'patch': {
      const { data } = await client.PATCH('/v1/teams/{teamId}/checklist-items/{itemId}', {
        params: { path, header },
        body: { ...write.patch, version },
      });
      return expectItem(data);
    }
    case 'assign': {
      const { data } = await client.PUT('/v1/teams/{teamId}/checklist-items/{itemId}/assignee', {
        params: { path, header },
        body: { version, userId: write.userId },
      });
      return expectItem(data);
    }
    case 'revertFallback': {
      const { data } = await client.POST(
        '/v1/teams/{teamId}/checklist-items/{itemId}/fallback-reverts',
        { params: { path, header }, body: { version } },
      );
      return expectItem(data);
    }
    case 'review': {
      const { data } = await client.PUT('/v1/teams/{teamId}/checklist-items/{itemId}/review', {
        params: { path, header },
        body: { version, answers: write.answers },
      });
      return expectItem(data);
    }
    case 'risk': {
      const { data } = await client.POST(
        '/v1/teams/{teamId}/checklist-items/{itemId}/review/risk-acceptances',
        {
          params: { path, header },
          body: { version, ordinal: write.ordinal, reason: write.reason },
        },
      );
      return expectItem(data);
    }
  }
}
