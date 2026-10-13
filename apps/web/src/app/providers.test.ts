import { MutationObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ME_QUERY_KEY } from '@/features/auth/session';
import { ApiError, NetworkError } from '@/lib/api/errors';
import { isSessionFailure, makeQueryClient, shouldRetryQuery } from './providers';

const apiError = (status: number, code: string) =>
  new ApiError({ status, body: undefined, problem: { code, status } as never });

const UNAUTHENTICATED = apiError(401, 'UNAUTHENTICATED');
const CONSENT_REQUIRED = apiError(403, 'CONSENT_REQUIRED');

function clientWithMe() {
  const client = makeQueryClient();
  client.setQueryData(ME_QUERY_KEY, { id: 'u1' });
  return client;
}
const invalidated = (client: ReturnType<typeof makeQueryClient>) =>
  client.getQueryState(ME_QUERY_KEY)?.isInvalidated === true;

async function failQuery(client: ReturnType<typeof makeQueryClient>, error: unknown) {
  await client
    .fetchQuery({
      queryKey: ['other'],
      queryFn: () => Promise.reject(error),
      retry: false,
    })
    .catch(() => undefined);
}
async function failMutation(client: ReturnType<typeof makeQueryClient>, error: unknown) {
  await new MutationObserver(client, { mutationFn: () => Promise.reject(error) })
    .mutate()
    .catch(() => undefined);
}

describe('S2CR-11: session failures are handled once, for every query and mutation', () => {
  it.each([
    ['a query 401 UNAUTHENTICATED', failQuery, UNAUTHENTICATED],
    ['a mutation 401 UNAUTHENTICATED', failMutation, UNAUTHENTICATED],
    ['a query 403 CONSENT_REQUIRED', failQuery, CONSENT_REQUIRED],
    ['a mutation 403 CONSENT_REQUIRED', failMutation, CONSENT_REQUIRED],
  ])('%s makes the current user be read again', async (_name, fail, error) => {
    const client = clientWithMe();
    await fail(client, error);
    expect(invalidated(client)).toBe(true);
  });

  it.each([
    ['a spent magic link (401 INVALID_TOKEN)', apiError(401, 'INVALID_TOKEN')],
    ['an expired link (401 EXPIRED_TOKEN)', apiError(401, 'EXPIRED_TOKEN')],
    ['a plain 403', apiError(403, 'FORBIDDEN')],
    ['a server error', apiError(500, 'INTERNAL')],
    ['a lost connection', new NetworkError()],
    ['a programming error', new Error('boom')],
  ])('%s leaves the user alone', async (_name, error) => {
    const client = clientWithMe();
    await failQuery(client, error);
    await failMutation(client, error);
    expect(invalidated(client)).toBe(false);
  });

  it('isSessionFailure recognises exactly the two cases', () => {
    expect(isSessionFailure(UNAUTHENTICATED)).toBe(true);
    expect(isSessionFailure(CONSENT_REQUIRED)).toBe(true);
    expect(isSessionFailure(apiError(401, 'INVALID_TOKEN'))).toBe(false);
    expect(isSessionFailure(undefined)).toBe(false);
  });
});

describe('shouldRetryQuery', () => {
  it('retries transient failures a bounded number of times, never definite 4xx', () => {
    expect(shouldRetryQuery(0, apiError(500, 'INTERNAL'))).toBe(true);
    expect(shouldRetryQuery(2, apiError(500, 'INTERNAL'))).toBe(false);
    expect(shouldRetryQuery(0, apiError(429, 'RATE_LIMITED'))).toBe(true);
    expect(shouldRetryQuery(0, UNAUTHENTICATED)).toBe(false);
    expect(shouldRetryQuery(0, new NetworkError())).toBe(true);
  });
});
