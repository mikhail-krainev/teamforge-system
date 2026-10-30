import type { OperationRequest } from './operations.js';

/**
 * The 11 operations of slice 7 (docs/plan.md, "Покрытие операций по срезам": 7; docs/api/openapi.yaml):
 * `rewards` 5 (listBadges, listUserAwards, getUserCounters, getTeamCredit, createDispute), `admin` 3
 * (listFraudCases, getFraudCase, decideFraudCase) and `profiles` 3 (listReceivedReviews, createPeerReview,
 * listSentReviews). A request is syntactically valid; the answer is the test's subject.
 */
export const REWARD_OPERATIONS = [
  'listBadges',
  'listUserAwards',
  'getUserCounters',
  'getTeamCredit',
  'createDispute',
] as const;

export const FRAUD_OPERATIONS = ['listFraudCases', 'getFraudCase', 'decideFraudCase'] as const;

export const REVIEW_OPERATIONS = ['listReceivedReviews', 'createPeerReview', 'listSentReviews'] as const;

export const SLICE7_OPERATIONS = [...REWARD_OPERATIONS, ...FRAUD_OPERATIONS, ...REVIEW_OPERATIONS];

export type Slice7Operation = (typeof SLICE7_OPERATIONS)[number];

export interface RewardsContext {
  teamId?: string;
  userId?: string;
  caseId?: string;
  subjectUserId?: string;
}

type Resolved = Required<RewardsContext>;
type Builder = (c: Resolved) => OperationRequest;

const NOWHERE = '00000000-0000-4000-8000-000000000999';

const BUILDERS: Record<Slice7Operation, Builder> = {
  listBadges: () => ({ method: 'GET', url: '/v1/badges' }),
  listUserAwards: (c) => ({ method: 'GET', url: `/v1/users/${c.userId}/awards` }),
  getUserCounters: (c) => ({ method: 'GET', url: `/v1/users/${c.userId}/counters` }),
  getTeamCredit: (c) => ({ method: 'GET', url: `/v1/teams/${c.teamId}/credit` }),
  createDispute: (c) => ({
    method: 'POST',
    url: `/v1/teams/${c.teamId}/disputes`,
    body: { text: 'Вклад участников выглядит накрученным, прошу проверить.' },
  }),
  listFraudCases: () => ({ method: 'GET', url: '/v1/admin/fraud-cases' }),
  getFraudCase: (c) => ({ method: 'GET', url: `/v1/admin/fraud-cases/${c.caseId}` }),
  decideFraudCase: (c) => ({
    method: 'POST',
    url: `/v1/admin/fraud-cases/${c.caseId}/decision`,
    body: { decision: 'violation', comment: 'Нарушение подтверждено, награды отозвать.' },
  }),
  listReceivedReviews: () => ({ method: 'GET', url: '/v1/me/reviews' }),
  createPeerReview: (c) => ({
    method: 'POST',
    url: `/v1/teams/${c.teamId}/reviews`,
    body: { subjectUserId: c.subjectUserId, text: 'Хорошо работал с задачами и вовремя отвечал.' },
  }),
  listSentReviews: (c) => ({ method: 'GET', url: `/v1/teams/${c.teamId}/reviews/sent` }),
};

/** A syntactically valid request for each slice 7 operation. */
export function requestForRewards(
  operationId: Slice7Operation,
  context: RewardsContext = {},
): OperationRequest {
  return BUILDERS[operationId]({
    teamId: context.teamId ?? NOWHERE,
    userId: context.userId ?? NOWHERE,
    caseId: context.caseId ?? NOWHERE,
    subjectUserId: context.subjectUserId ?? NOWHERE,
  });
}
