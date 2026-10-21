import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';

export type FraudCase = Schema<'FraudCase'>;
export type FraudStatus = FraudCase['status'];
export type FraudDecisionValue = Schema<'FraudDecision'>['decision'];

type Client = typeof apiClient;

export const PAGE_SIZE = 20;
export const casesKey = (status: FraudStatus) => ['admin', 'fraud', 'list', status] as const;
export const caseKey = (caseId: string) => ['admin', 'fraud', 'case', caseId] as const;
export const casesRootKey = ['admin', 'fraud'] as const;

export async function fetchCases(
  status: FraudStatus,
  cursor: string | undefined,
  client: Pick<Client, 'GET'> = apiClient,
) {
  const { data } = await client.GET('/v1/admin/fraud-cases', {
    params: { query: { status, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) } },
  });
  if (!data) throw new Error('Empty fraud cases response');
  return data;
}

export async function fetchCase(caseId: string, client: Pick<Client, 'GET'> = apiClient) {
  const { data } = await client.GET('/v1/admin/fraud-cases/{caseId}', {
    params: { path: { caseId } },
  });
  if (!data) throw new Error('Empty fraud case response');
  return data;
}

export async function decideCase(
  caseId: string,
  input: { decision: FraudDecisionValue; comment: string },
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/admin/fraud-cases/{caseId}/decision', {
    params: { path: { caseId }, header: { 'Idempotency-Key': key } },
    body: input,
  });
  if (!data) throw new Error('Empty decision response');
  return data;
}
