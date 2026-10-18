import type { OperationRequest } from './operations.js';

/**
 * The 14 operations of slice 6 (docs/plan.md, "Покрытие операций по срезам": 6; docs/api/openapi.yaml):
 * `github` 7 (createInstallationSession, githubSetupCallback, listAvailableRepositories, linkRepository,
 * getRepository, unlinkRepository, receiveGithubWebhook) and `workspace` 7 (getTeamFeed,
 * getContributionSummary, relabelContribution, requestCompletionCheck, getLatestCompletionCheck,
 * completeProject, getCompletion). A request is syntactically valid; the answer is the test's subject.
 */
export const GITHUB_OPERATIONS = [
  'createInstallationSession',
  'githubSetupCallback',
  'listAvailableRepositories',
  'linkRepository',
  'getRepository',
  'unlinkRepository',
  'receiveGithubWebhook',
] as const;

export const FEED_OPERATIONS = [
  'getTeamFeed',
  'getContributionSummary',
  'relabelContribution',
  'requestCompletionCheck',
  'getLatestCompletionCheck',
  'completeProject',
  'getCompletion',
] as const;

export const SLICE6_OPERATIONS = [...GITHUB_OPERATIONS, ...FEED_OPERATIONS];

export type Slice6Operation = (typeof SLICE6_OPERATIONS)[number];

export interface GithubContext {
  teamId?: string;
  installationId?: number;
  repositoryId?: number;
  contributionId?: string;
  roleCode?: string;
}

type Resolved = Required<GithubContext>;
type Builder = (c: Resolved) => OperationRequest;

const NOWHERE = '00000000-0000-4000-8000-000000000999';

const BUILDERS: Record<Slice6Operation, Builder> = {
  createInstallationSession: (c) => ({
    method: 'POST',
    url: `/v1/teams/${c.teamId}/github/installation-sessions`,
  }),
  githubSetupCallback: () => ({
    method: 'GET',
    url: '/v1/github/setup?installation_id=1&setup_action=install&state=nonexistentstate&code=nocode',
  }),
  listAvailableRepositories: (c) => ({
    method: 'GET',
    url: `/v1/teams/${c.teamId}/github/available-repositories?installationId=${c.installationId}`,
  }),
  linkRepository: (c) => ({
    method: 'PUT',
    url: `/v1/teams/${c.teamId}/repository`,
    body: { installationId: c.installationId, repositoryId: c.repositoryId },
  }),
  getRepository: (c) => ({ method: 'GET', url: `/v1/teams/${c.teamId}/repository` }),
  unlinkRepository: (c) => ({ method: 'DELETE', url: `/v1/teams/${c.teamId}/repository` }),
  receiveGithubWebhook: () => ({
    method: 'POST',
    url: '/v1/webhooks/github',
    body: { zen: 'Keep it logically awesome.' },
  }),
  getTeamFeed: (c) => ({ method: 'GET', url: `/v1/teams/${c.teamId}/feed` }),
  getContributionSummary: (c) => ({
    method: 'GET',
    url: `/v1/teams/${c.teamId}/contributions/summary`,
  }),
  relabelContribution: (c) => ({
    method: 'PATCH',
    url: `/v1/teams/${c.teamId}/contributions/${c.contributionId}`,
    body: { roleCode: c.roleCode },
  }),
  requestCompletionCheck: (c) => ({
    method: 'POST',
    url: `/v1/teams/${c.teamId}/completion-checks`,
  }),
  getLatestCompletionCheck: (c) => ({
    method: 'GET',
    url: `/v1/teams/${c.teamId}/completion-checks/latest`,
  }),
  completeProject: (c) => ({ method: 'POST', url: `/v1/teams/${c.teamId}/completion` }),
  getCompletion: (c) => ({ method: 'GET', url: `/v1/teams/${c.teamId}/completion` }),
};

/** A syntactically valid request for each slice 6 operation. */
export function requestForGithub(
  operationId: Slice6Operation,
  context: GithubContext = {},
): OperationRequest {
  return BUILDERS[operationId]({
    teamId: context.teamId ?? NOWHERE,
    installationId: context.installationId ?? 70_000_001,
    repositoryId: context.repositoryId ?? 810_000_001,
    contributionId: context.contributionId ?? NOWHERE,
    roleCode: context.roleCode ?? 'backend',
  });
}
