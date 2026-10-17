import { miniPlaybookYaml } from './playbooks.js';
import { pdfFile } from './artifact-files.js';
import type { OperationRequest } from './operations.js';

/**
 * The 18 operations of slice 5 (docs/plan.md, "Покрытие операций по срезам": 5). Paths and bodies come
 * from docs/api/openapi.yaml. A request is syntactically valid; what the response is, is the test's subject.
 */
export const PLAYBOOK_OPERATIONS = [
  'listPlaybooks',
  'getPlaybook',
  'getTemplate',
  'adminListPlaybooks',
  'uploadPlaybook',
  'publishPlaybook',
] as const;

export const WORKSPACE_OPERATIONS = [
  'listStages',
  'getStageChecklist',
  'updateChecklistItem',
  'assignChecklistItem',
  'revertFallback',
  'uploadArtifactFile',
  'getArtifactDownloadUrl',
  'deleteArtifactFile',
  'submitReview',
  'acceptReviewRisk',
  'transitionStage',
  'confirmParticipation',
] as const;

export const SLICE5_OPERATIONS = [...PLAYBOOK_OPERATIONS, ...WORKSPACE_OPERATIONS];

export type Slice5Operation = (typeof SLICE5_OPERATIONS)[number];

export interface WorkspaceContext {
  teamId?: string;
  itemId?: string;
  fileId?: string;
  ordinal?: number;
  playbookId?: string;
  templateKey?: string;
  userId?: string;
  version?: number;
}

const NOWHERE = '00000000-0000-4000-8000-000000000999';

type Resolved = Required<WorkspaceContext>;
type Builder = (c: Resolved) => OperationRequest;

const item = (c: Resolved): string => `/v1/teams/${c.teamId}/checklist-items/${c.itemId}`;

const BUILDERS: Record<Slice5Operation, Builder> = {
  listPlaybooks: () => ({ method: 'GET', url: '/v1/playbooks' }),
  getPlaybook: (c) => ({ method: 'GET', url: `/v1/playbooks/${c.playbookId}` }),
  getTemplate: (c) => ({ method: 'GET', url: `/v1/templates/${c.templateKey}` }),
  adminListPlaybooks: () => ({ method: 'GET', url: '/v1/admin/playbooks' }),
  uploadPlaybook: () => ({
    method: 'POST',
    url: '/v1/admin/playbooks',
    body: miniPlaybookYaml({ version: '9.99.0' }),
  }),
  publishPlaybook: (c) => ({
    method: 'POST',
    url: `/v1/admin/playbooks/${c.playbookId}/publication`,
  }),
  listStages: (c) => ({ method: 'GET', url: `/v1/teams/${c.teamId}/stages` }),
  getStageChecklist: (c) => ({
    method: 'GET',
    url: `/v1/teams/${c.teamId}/stages/${c.ordinal}/checklist`,
  }),
  updateChecklistItem: (c) => ({
    method: 'PATCH',
    url: item(c),
    body: { version: c.version, outcome: 'Итоги встречи записаны в поле итогов пункта.' },
  }),
  assignChecklistItem: (c) => ({
    method: 'PUT',
    url: `${item(c)}/assignee`,
    body: { version: c.version, userId: c.userId },
  }),
  revertFallback: (c) => ({
    method: 'POST',
    url: `${item(c)}/fallback-reverts`,
    body: { version: c.version },
  }),
  uploadArtifactFile: (c) => ({ method: 'POST', url: `${item(c)}/files`, upload: pdfFile() }),
  getArtifactDownloadUrl: (c) => ({
    method: 'GET',
    url: `${item(c)}/files/${c.fileId}/download-url`,
  }),
  deleteArtifactFile: (c) => ({ method: 'DELETE', url: `${item(c)}/files/${c.fileId}` }),
  submitReview: (c) => ({
    method: 'PUT',
    url: `${item(c)}/review`,
    body: { version: c.version, answers: [{ ordinal: 1, answer: true }] },
  }),
  acceptReviewRisk: (c) => ({
    method: 'POST',
    url: `${item(c)}/review/risk-acceptances`,
    body: { version: c.version, ordinal: 1, reason: 'Риск принят, исправим позже' },
  }),
  transitionStage: (c) => ({
    method: 'POST',
    url: `/v1/teams/${c.teamId}/stage-transitions`,
    body: { fromOrdinal: c.ordinal },
  }),
  confirmParticipation: (c) => ({
    method: 'POST',
    url: `/v1/teams/${c.teamId}/participation-confirmations`,
    body: { userId: c.userId, stageOrdinal: c.ordinal },
  }),
};

/** A syntactically valid request for each slice 5 operation. */
export function requestForWorkspace(
  operationId: Slice5Operation,
  context: WorkspaceContext = {},
): OperationRequest {
  return BUILDERS[operationId]({
    teamId: context.teamId ?? NOWHERE,
    itemId: context.itemId ?? NOWHERE,
    fileId: context.fileId ?? NOWHERE,
    ordinal: context.ordinal ?? 1,
    playbookId: context.playbookId ?? NOWHERE,
    templateKey: context.templateKey ?? 'tpl_charter',
    userId: context.userId ?? NOWHERE,
    version: context.version ?? 1,
  });
}

/** Content type of the request body (`uploadPlaybook` takes the file text itself). */
export function headersFor(request: OperationRequest): Record<string, string> {
  return typeof request.body === 'string' ? { 'content-type': 'application/yaml' } : {};
}
