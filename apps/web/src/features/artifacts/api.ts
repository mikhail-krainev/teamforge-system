import type { Schema } from 'shared';
import { apiClient } from '@/lib/api/client';
import { NetworkError, toApiError } from '@/lib/api/errors';

export type ArtifactFile = Schema<'ArtifactFile'>;

interface Target {
  teamId: string;
  itemId: string;
}

/** Same origin as the generated client (`createApiClient` default): Next proxies `/api/*`. */
const API_BASE = '/api';

export const downloadKey = (teamId: string, itemId: string, fileId: string) =>
  ['artifact-download', teamId, itemId, fileId] as const;

function filesUrl({ teamId, itemId }: Target): string {
  return `${API_BASE}/v1/teams/${teamId}/checklist-items/${itemId}/files`;
}

function toResponse(xhr: XMLHttpRequest): Response {
  const headers = new Headers();
  const retryAfter = xhr.getResponseHeader('Retry-After');
  if (retryAfter !== null) headers.set('Retry-After', retryAfter);
  return new Response(xhr.responseText, { status: xhr.status, headers });
}

/**
 * `uploadArtifactFile` over XMLHttpRequest: `fetch` cannot report upload progress. The response is
 * turned into the same `ApiError` / `NetworkError` the generated client throws.
 */
export function uploadArtifactFile(
  target: Target,
  file: File,
  key: string,
  onProgress: (percent: number) => void,
): Promise<ArtifactFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', filesUrl(target));
    xhr.setRequestHeader('Idempotency-Key', key);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      const response = toResponse(xhr);
      if (xhr.status >= 200 && xhr.status < 300) {
        response.json().then((body: ArtifactFile) => resolve(body), reject);
      } else {
        toApiError(response).then(reject, reject);
      }
    };
    const fail = () => reject(new NetworkError());
    xhr.onerror = fail;
    xhr.onabort = fail;
    xhr.ontimeout = fail;
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}

export async function fetchDownloadUrl(
  target: Target,
  fileId: string,
  client: Pick<typeof apiClient, 'GET'> = apiClient,
) {
  const { data } = await client.GET(
    '/v1/teams/{teamId}/checklist-items/{itemId}/files/{fileId}/download-url',
    { params: { path: { ...target, fileId } } },
  );
  if (!data) throw new Error('Empty download url response');
  return data;
}

export async function deleteArtifactFile(
  target: Target,
  fileId: string,
  key: string,
  client: Pick<typeof apiClient, 'DELETE'> = apiClient,
): Promise<void> {
  await client.DELETE('/v1/teams/{teamId}/checklist-items/{itemId}/files/{fileId}', {
    params: { path: { ...target, fileId }, header: { 'Idempotency-Key': key } },
  });
}
