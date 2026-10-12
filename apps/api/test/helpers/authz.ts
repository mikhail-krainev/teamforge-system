import { expect } from 'vitest';
import { findOperation, type XAuthz } from './contract.js';

/** Actors for whom a foreign resource must look like it does not exist (404, not 403). */
const SCOPED_ACTORS = new Set([
  'team-member',
  'team-participant',
  'team-lead',
  'offer-party',
  'invitee',
  'vote-participant',
]);
const UNAUTHENTICATED_ACTORS = new Set(['public', 'github-signature']);
const ADMIN_PROTECTED_PATH = /resume|review/i;

export type IdorKind = 'anonymous' | 'outsider' | 'swapped-id' | 'low-role' | 'admin';

/** One negative case derived from `x-authz`; the slice's test supplies the fixtures that realise it. */
export interface IdorCase {
  kind: IdorKind;
  title: string;
  expectedStatus: 401 | 403 | 404;
  /** For `swapped-id`: the nested path parameter that is replaced by an id of another team. */
  swappedParam?: string;
}

export interface IdorMatrix {
  operationId: string;
  method: string;
  path: string;
  authz: XAuthz;
  cases: IdorCase[];
}

/**
 * Builds the IDOR/authorization matrix of an operation from its `x-authz` (docs/plan.md, "IDOR"):
 *  (а) a user outside the team gets 404 for a foreign resource, never 403;
 *  (б) a nested id taken from another team (chain element 2+) gives 404;
 *  (в) a role below the required one gets 403;
 *  (г) an administrator gets 404 on other users' resumes and reviews;
 *  and, for every non-public operation, a call without a session gives 401.
 * The matrix only describes the cases; the test calls the API with its own fixtures and checks each
 * response with `expectIdorResult`.
 */
export function idorMatrix(operationId: string): IdorMatrix {
  const { method, path, operation } = findOperation(operationId);
  const authz = operation['x-authz'];
  if (!authz) throw new Error(`${operationId} has no x-authz`);
  const chain = authz.chain ?? [];
  const cases: IdorCase[] = [];

  if (!UNAUTHENTICATED_ACTORS.has(authz.actor)) {
    cases.push({ kind: 'anonymous', title: 'no session -> 401', expectedStatus: 401 });
  }
  if (SCOPED_ACTORS.has(authz.actor) && chain.length > 0) {
    cases.push({
      kind: 'outsider',
      title: 'user outside the team -> 404 (not 403)',
      expectedStatus: 404,
    });
  }
  for (const param of chain.slice(1)) {
    cases.push({
      kind: 'swapped-id',
      title: `nested ${param} of another team -> 404, nothing changed`,
      expectedStatus: 404,
      swappedParam: param,
    });
  }
  if (authz.actor === 'team-lead') {
    cases.push({
      kind: 'low-role',
      title: 'member without the lead role -> 403 with a code',
      expectedStatus: 403,
    });
  }
  if (authz.actor === 'self' && ADMIN_PROTECTED_PATH.test(path)) {
    cases.push({
      kind: 'admin',
      title: 'administrator on a foreign resume or review -> 404',
      expectedStatus: 404,
    });
  }
  return { operationId, method, path, authz, cases };
}

/** Asserts the status of a realised IDOR case. */
export function expectIdorResult(testCase: IdorCase, response: { statusCode: number }): void {
  expect(response.statusCode, testCase.title).toBe(testCase.expectedStatus);
}
