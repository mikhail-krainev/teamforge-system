import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import type { Profile, ProfileFields } from '../model';

export type ResumeUpload = Schema<'ResumeUpload'>;

export const RESUME_KEY = ['resume', 'me'] as const;
export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
export const POLL_MS = 2000;

const ACCEPTED_EXTENSIONS = ['.pdf', '.docx'];

/** Cheap client-side pre-check; the server decides by magic bytes (FR-PROF-02). */
export function checkResumeFile(
  file: Pick<File, 'name' | 'size'>,
): 'ok' | 'wrongType' | 'tooLarge' {
  const name = file.name.toLowerCase();
  if (!ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext))) return 'wrongType';
  return file.size > MAX_RESUME_BYTES ? 'tooLarge' : 'ok';
}

export function isInProgress(upload: ResumeUpload | null | undefined): boolean {
  return upload?.status === 'queued' || upload?.status === 'processing';
}

/** `getMyResume`; `null` when nothing is uploaded (404). */
export async function fetchMyResume(
  client: Pick<typeof apiClient, 'GET'> = apiClient,
): Promise<ResumeUpload | null> {
  try {
    const { data } = await client.GET('/v1/me/resume');
    return data ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function uploadResume(
  file: File,
  key: string,
  client: Pick<typeof apiClient, 'POST'> = apiClient,
): Promise<ResumeUpload> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await client.POST('/v1/me/resume', {
    // The browser adds the multipart boundary itself; the body is the prepared FormData.
    body: { file: '' },
    bodySerializer: () => form,
    params: { header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty upload response');
  return data;
}

export interface ConfirmInput {
  uploadId: string;
  fields: ProfileFields;
  keepFile: boolean;
  profileVersion: number | null;
}

export async function confirmResume(
  input: ConfirmInput,
  key: string,
  client: Pick<typeof apiClient, 'POST'> = apiClient,
): Promise<Profile> {
  const { data } = await client.POST('/v1/me/resume/{uploadId}/confirmations', {
    body: {
      confirmedFields: input.fields,
      keepFile: input.keepFile,
      profileVersion: input.profileVersion,
    },
    params: { path: { uploadId: input.uploadId }, header: { 'Idempotency-Key': key } },
  });
  if (!data) throw new Error('Empty confirmation response');
  return data;
}

/** `deleteResume`; a repeated delete (404) means the goal is already reached. */
export async function removeResume(
  uploadId: string,
  key: string,
  client: Pick<typeof apiClient, 'DELETE'> = apiClient,
): Promise<void> {
  try {
    await client.DELETE('/v1/me/resume/{uploadId}', {
      params: { path: { uploadId }, header: { 'Idempotency-Key': key } },
    });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
}
