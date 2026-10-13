import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';

export type Invitation = Schema<'Invitation'>;
export type InvitationCreate = Schema<'InvitationCreate'>;
export type InvitationCreated = Schema<'InvitationCreated'>;
export type InvitationPreview = Schema<'InvitationPreview'>;
export type JoinResult = Schema<'JoinResult'>;

type Client = typeof apiClient;

export const INVITATIONS_PAGE = 20;
export const invitationsKey = (teamId: string) => ['invitations', teamId] as const;

export async function fetchInvitations(
  teamId: string,
  cursor: string | undefined,
  client: Pick<Client, 'GET'> = apiClient,
) {
  const { data } = await client.GET('/v1/teams/{teamId}/invitations', {
    params: {
      path: { teamId },
      query: { limit: INVITATIONS_PAGE, ...(cursor ? { cursor } : {}) },
    },
  });
  if (!data) throw new Error('Empty invitations response');
  return data;
}

export async function createInvitation(
  teamId: string,
  body: InvitationCreate,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/teams/{teamId}/invitations', {
    body,
    params: { path: { teamId }, header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty invitation response');
  return data;
}

export async function revokeInvitation(
  teamId: string,
  invitationId: string,
  key: string,
  client: Pick<Client, 'DELETE'> = apiClient,
) {
  await client.DELETE('/v1/teams/{teamId}/invitations/{invitationId}', {
    params: { path: { teamId, invitationId }, header: { 'Idempotency-Key': key } },
  });
}

/** The token travels in the POST body only, never in a URL (SEC-09). */
export async function previewInvitation(token: string, client: Pick<Client, 'POST'> = apiClient) {
  const { data } = await client.POST('/v1/invitation-previews', { body: { token } });
  if (!data) throw new Error('Empty preview response');
  return data;
}

export async function acceptInvitation(
  token: string,
  key: string,
  client: Pick<Client, 'POST'> = apiClient,
) {
  const { data } = await client.POST('/v1/invitation-acceptances', {
    body: { token },
    params: { header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty join response');
  return data;
}
