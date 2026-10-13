import { randomUUID } from 'node:crypto';
import type { InjectResponse } from '../helpers/http.js';
import type { CallOptions, Caller, UploadFile } from './clients.js';
import { profileInput, resumeFile } from './profiles.js';

/** The 25 operations of slice 2 by module (docs/plan.md, "Покрытие операций по срезам"). */
export const AUTH_OPERATIONS = [
  'getMe',
  'getCurrentConsentText',
  'acceptConsent',
  'requestDeletion',
  'cancelDeletionRequest',
  'getMyGithubAccount',
  'signInSocial',
  'signInMagicLink',
  'verifyMagicLink',
  'linkGithub',
  'signOut',
  'getSession',
] as const;

export const PROFILE_OPERATIONS = [
  'getMyProfile',
  'saveMyProfile',
  'getPublicProfile',
  'uploadResume',
  'getMyResume',
  'confirmResumeFields',
  'deleteResume',
  'listRoles',
  'createRole',
  'updateRole',
  'listStackTags',
  'createStackTag',
  'updateStackTag',
] as const;

export const SLICE2_OPERATIONS = [...AUTH_OPERATIONS, ...PROFILE_OPERATIONS];

export interface OperationContext {
  userId?: string;
  uploadId?: string;
  code?: string;
}

export interface OperationRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  body?: unknown;
  upload?: UploadFile;
}

const FOREIGN = '00000000-0000-4000-8000-000000000999';

type OperationId = (typeof SLICE2_OPERATIONS)[number];
type Builder = (context: Required<OperationContext>) => OperationRequest;

const get =
  (url: string): Builder =>
  () => ({ method: 'GET', url });
const post =
  (url: string, body?: unknown): Builder =>
  () => ({ method: 'POST', url, body });

const BUILDERS: Record<OperationId, Builder> = {
  getMe: get('/v1/me'),
  getCurrentConsentText: get('/v1/consent/current'),
  acceptConsent: post('/v1/me/consents', { version: 'x', textHash: 'a'.repeat(64) }),
  requestDeletion: post('/v1/me/deletion-requests', { reason: 'user_request', confirm: true }),
  cancelDeletionRequest: post('/v1/deletion-request-cancellations', { token: 'A'.repeat(43) }),
  getMyGithubAccount: get('/v1/me/github'),
  signInSocial: post('/auth/sign-in/social', { provider: 'github' }),
  signInMagicLink: () => ({
    method: 'POST',
    url: '/auth/sign-in/magic-link',
    body: { email: `idor-${randomUUID()}@example.test` },
  }),
  verifyMagicLink: post('/auth/magic-link/confirm', { token: 'T'.repeat(32) }),
  linkGithub: post('/auth/link-social', { provider: 'github' }),
  signOut: post('/auth/sign-out'),
  getSession: get('/auth/get-session'),
  getMyProfile: get('/v1/me/profile'),
  saveMyProfile: () => ({ method: 'PUT', url: '/v1/me/profile', body: profileInput() }),
  getPublicProfile: (c) => ({ method: 'GET', url: `/v1/users/${c.userId}/profile` }),
  uploadResume: () => ({ method: 'POST', url: '/v1/me/resume', upload: resumeFile('resume.pdf') }),
  getMyResume: get('/v1/me/resume'),
  confirmResumeFields: (c) => ({
    method: 'POST',
    url: `/v1/me/resume/${c.uploadId}/confirmations`,
    body: { confirmedFields: { stack: ['typescript'] }, keepFile: false, profileVersion: null },
  }),
  deleteResume: (c) => ({ method: 'DELETE', url: `/v1/me/resume/${c.uploadId}` }),
  listRoles: get('/v1/catalog/roles'),
  createRole: (c) => ({
    method: 'POST',
    url: '/v1/admin/catalog/roles',
    body: { code: c.code, name: 'Test entry' },
  }),
  updateRole: (c) => ({
    method: 'PATCH',
    url: `/v1/admin/catalog/roles/${c.code}`,
    body: { name: 'Renamed' },
  }),
  listStackTags: get('/v1/catalog/stack-tags'),
  createStackTag: (c) => ({
    method: 'POST',
    url: '/v1/admin/catalog/stack-tags',
    body: { code: c.code, name: 'Test entry' },
  }),
  updateStackTag: (c) => ({
    method: 'PATCH',
    url: `/v1/admin/catalog/stack-tags/${c.code}`,
    body: { name: 'Renamed' },
  }),
};

/** A syntactically valid request for each operation; the response is what the test is about. */
export function requestFor(
  operationId: OperationId,
  context: OperationContext = {},
): OperationRequest {
  return BUILDERS[operationId]({
    userId: context.userId ?? FOREIGN,
    uploadId: context.uploadId ?? FOREIGN,
    code: context.code ?? 'qa_automation',
  });
}

/** Sends the operation's request as `caller`. Auth routes of the library take no Idempotency-Key. */
export function send(
  caller: Caller,
  request: OperationRequest,
  options: CallOptions = {},
): Promise<InjectResponse> {
  const noKey =
    request.url.startsWith('/auth/') || request.url.includes('deletion-request-cancellations');
  const merged: CallOptions = noKey ? { ...options, idempotencyKey: null } : options;
  if (request.upload) return caller.upload(request.url, request.upload, merged);
  return caller.request(request.method, request.url, request.body, merged);
}
