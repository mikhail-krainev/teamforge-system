import { apiClient } from '@/lib/api/client';

type Client = typeof apiClient;

export async function excludeTrialMember(
  teamId: string,
  userId: string,
  key: string,
  client: Pick<Client, 'DELETE'> = apiClient,
) {
  await client.DELETE('/v1/teams/{teamId}/members/{userId}', {
    params: { path: { teamId, userId }, header: { 'Idempotency-Key': key } },
  });
}

export async function confirmTrial(
  teamId: string,
  userId: string,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/teams/{teamId}/members/{userId}/trial-confirmation', {
    params: { path: { teamId, userId }, header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty trial response');
  return data;
}
