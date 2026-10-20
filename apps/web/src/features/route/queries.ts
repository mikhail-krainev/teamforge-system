'use client';

import { useQuery } from '@tanstack/react-query';
import {
  checklistKey,
  fetchChecklist,
  fetchPlaybook,
  fetchStages,
  fetchTemplate,
  playbookKey,
  stagesKey,
  templateKey,
  type ChecklistItem,
} from './api';

const CATALOG_STALE_MS = 10 * 60_000;
/** How often a checklist with a link check in progress is re-read until the worker finishes. */
export const LINK_CHECK_POLL_MS = 3000;

export function hasLinkCheckRunning(items: readonly ChecklistItem[] | undefined): boolean {
  return Boolean(items?.some((item) => item.linkStatus === 'unchecked'));
}

export function useStages(teamId: string) {
  return useQuery({ queryKey: stagesKey(teamId), queryFn: () => fetchStages(teamId) });
}

export function useChecklist(teamId: string, ordinal: number, enabled: boolean) {
  return useQuery({
    queryKey: checklistKey(teamId, ordinal),
    enabled,
    queryFn: () => fetchChecklist(teamId, ordinal),
    refetchInterval: (query) =>
      hasLinkCheckRunning(query.state.data) ? LINK_CHECK_POLL_MS : false,
  });
}

/** The published playbook is immutable, so it is read once; failing to load it only hides hints. */
export function usePlaybook(playbookId: string | undefined) {
  return useQuery({
    queryKey: playbookKey(playbookId ?? ''),
    queryFn: () => fetchPlaybook(playbookId ?? ''),
    enabled: Boolean(playbookId),
    staleTime: CATALOG_STALE_MS,
  });
}

export function useTemplate(key: string, enabled: boolean) {
  return useQuery({
    queryKey: templateKey(key),
    queryFn: () => fetchTemplate(key),
    enabled,
    staleTime: CATALOG_STALE_MS,
  });
}
