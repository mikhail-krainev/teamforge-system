// Sample data for matching component tests (typed by the generated contract).
import type { MatchReasons } from '@/features/recommendations/api';
import type { RoleDemand, SearchApplication } from './api';

export const APPLICATION_ID = '0192f0a0-7c1e-7b3a-8d2f-00000000a901';

export function sampleApplication(overrides: Partial<SearchApplication> = {}): SearchApplication {
  return {
    id: APPLICATION_ID,
    status: 'active',
    enqueuedAt: '2026-01-01T10:00:00.000Z',
    roles: [
      { roleCode: 'backend', priority: 1, addedAt: '2026-01-01T10:00:00.000Z' },
      { roleCode: 'qa', priority: 2, addedAt: '2026-01-01T10:00:00.000Z' },
    ],
    version: 2,
    ...overrides,
  };
}

export function sampleDemand(overrides: Partial<RoleDemand> = {}): RoleDemand {
  return {
    roleCode: 'backend',
    teamsSeeking: 3,
    openSeats: 4,
    queuedCandidates: 7,
    avgWaitSeconds: 3 * 86_400,
    avgWaitStatus: 'ok',
    deficit: true,
    computedAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

export function sampleReasons(overrides: Partial<MatchReasons> = {}): MatchReasons {
  return {
    role: true,
    stack: 0.8,
    level: 1,
    timezone: 0.7,
    availability: 0.9,
    completedProjects: 0.5,
    matchedStackTags: ['node', 'react'],
    timezoneDiffHours: 2,
    ...overrides,
  };
}
