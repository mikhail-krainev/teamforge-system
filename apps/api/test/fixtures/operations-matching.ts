import type { OperationRequest } from './operations.js';

/**
 * The 9 operations of slice 4 (docs/plan.md, "Покрытие операций по срезам": 4). Paths and bodies come
 * from docs/api/openapi.yaml; `excludeTrialMember` and `confirmTrial` are tagged `teams` in the
 * contract but belong to this slice (they need `joined_via = 'auto'`).
 */
export const SLICE4_OPERATIONS = [
  'getMySearchApplication',
  'createSearchApplication',
  'updateSearchApplication',
  'cancelSearchApplication',
  'getRoleDemand',
  'listRecommendedTeams',
  'listSeatCandidates',
  'excludeTrialMember',
  'confirmTrial',
] as const;

export type Slice4Operation = (typeof SLICE4_OPERATIONS)[number];

export interface MatchingContext {
  teamId?: string;
  seatId?: string;
  userId?: string;
  roleCode?: string;
  version?: number;
}

const NOWHERE = '00000000-0000-4000-8000-000000000999';

type Resolved = Required<MatchingContext>;
type Builder = (c: Resolved) => OperationRequest;

const BUILDERS: Record<Slice4Operation, Builder> = {
  getMySearchApplication: () => ({ method: 'GET', url: '/v1/me/search-application' }),
  createSearchApplication: (c) => ({
    method: 'POST',
    url: '/v1/me/search-application',
    body: { roles: [{ roleCode: c.roleCode, priority: 1 }] },
  }),
  updateSearchApplication: (c) => ({
    method: 'PUT',
    url: '/v1/me/search-application',
    body: { roles: [{ roleCode: c.roleCode, priority: 1 }], version: c.version },
  }),
  cancelSearchApplication: () => ({ method: 'DELETE', url: '/v1/me/search-application' }),
  getRoleDemand: (c) => ({ method: 'GET', url: `/v1/demand?roles=${c.roleCode}` }),
  listRecommendedTeams: () => ({ method: 'GET', url: '/v1/me/recommended-teams' }),
  listSeatCandidates: (c) => ({
    method: 'GET',
    url: `/v1/teams/${c.teamId}/seats/${c.seatId}/candidates`,
  }),
  excludeTrialMember: (c) => ({
    method: 'DELETE',
    url: `/v1/teams/${c.teamId}/members/${c.userId}`,
  }),
  confirmTrial: (c) => ({
    method: 'POST',
    url: `/v1/teams/${c.teamId}/members/${c.userId}/trial-confirmation`,
  }),
};

/** A syntactically valid request for each slice 4 operation; the response is what the test is about. */
export function requestForMatching(
  operationId: Slice4Operation,
  context: MatchingContext = {},
): OperationRequest {
  return BUILDERS[operationId]({
    teamId: context.teamId ?? NOWHERE,
    seatId: context.seatId ?? NOWHERE,
    userId: context.userId ?? NOWHERE,
    roleCode: context.roleCode ?? 'backend',
    version: context.version ?? 1,
  });
}
