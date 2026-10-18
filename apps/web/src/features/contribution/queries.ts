'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchSummary, summaryKey } from './api';

export function useContributionSummary(teamId: string) {
  return useQuery({ queryKey: summaryKey(teamId), queryFn: () => fetchSummary(teamId) });
}
