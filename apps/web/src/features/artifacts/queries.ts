'use client';

import { useQuery } from '@tanstack/react-query';
import { downloadKey, fetchDownloadUrl } from './api';

/** The signed link lives 5 minutes: it is re-read a minute before it would expire. */
const DOWNLOAD_REFRESH_MS = 4 * 60_000;

export function useDownloadUrl(teamId: string, itemId: string, fileId: string) {
  return useQuery({
    queryKey: downloadKey(teamId, itemId, fileId),
    queryFn: () => fetchDownloadUrl({ teamId, itemId }, fileId),
    staleTime: DOWNLOAD_REFRESH_MS,
    refetchInterval: DOWNLOAD_REFRESH_MS,
  });
}
