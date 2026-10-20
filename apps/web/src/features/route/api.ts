import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';

export type ProjectStage = Schema<'ProjectStage'>;
export type ChecklistItem = Schema<'ChecklistItem'>;
export type Playbook = Schema<'Playbook'>;
export type PlaybookStage = Schema<'PlaybookStage'>;
export type PlaybookStep = Schema<'PlaybookStep'>;
export type Template = Schema<'Template'>;

type Client = typeof apiClient;

/** Root of every query of the project workspace: one prefix refreshes stages and checklists. */
export const workspaceKey = (teamId: string) => ['workspace', teamId] as const;
export const stagesKey = (teamId: string) => ['workspace', teamId, 'stages'] as const;
export const checklistRootKey = (teamId: string) => ['workspace', teamId, 'checklist'] as const;
export const checklistKey = (teamId: string, ordinal: number) =>
  ['workspace', teamId, 'checklist', ordinal] as const;
export const playbookKey = (playbookId: string) => ['playbook', playbookId] as const;
export const templateKey = (key: string) => ['template', key] as const;

export async function fetchStages(teamId: string, client: Pick<Client, 'GET'> = apiClient) {
  const { data } = await client.GET('/v1/teams/{teamId}/stages', {
    params: { path: { teamId } },
  });
  if (!data) throw new Error('Empty stages response');
  return data;
}

export async function fetchChecklist(
  teamId: string,
  ordinal: number,
  client: Pick<Client, 'GET'> = apiClient,
) {
  const { data } = await client.GET('/v1/teams/{teamId}/stages/{ordinal}/checklist', {
    params: { path: { teamId, ordinal } },
  });
  if (!data) throw new Error('Empty checklist response');
  return data.items;
}

export async function fetchPlaybook(playbookId: string, client: Pick<Client, 'GET'> = apiClient) {
  const { data } = await client.GET('/v1/playbooks/{playbookId}', {
    params: { path: { playbookId } },
  });
  if (!data) throw new Error('Empty playbook response');
  return data;
}

export async function fetchTemplate(key: string, client: Pick<Client, 'GET'> = apiClient) {
  const { data } = await client.GET('/v1/templates/{key}', { params: { path: { key } } });
  if (!data) throw new Error('Empty template response');
  return data;
}
