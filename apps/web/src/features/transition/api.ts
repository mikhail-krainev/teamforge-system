import { apiClient } from '@/lib/api/client';

type Client = typeof apiClient;

export async function transitionStage(
  teamId: string,
  fromOrdinal: number,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/teams/{teamId}/stage-transitions', {
    params: { path: { teamId }, header: { 'Idempotency-Key': key } },
    body: { fromOrdinal },
  });
  if (!data) throw new Error('Empty stage transition response');
  return data;
}

export async function confirmParticipation(
  teamId: string,
  input: { userId: string; stageOrdinal: number },
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/teams/{teamId}/participation-confirmations', {
    params: { path: { teamId }, header: { 'Idempotency-Key': key } },
    body: input,
  });
  if (!data) throw new Error('Empty participation response');
  return data;
}
