// Sample data for the feed and contribution tests (typed by the generated contract).
import type { ContributionSummary } from '@/features/contribution/api';
import { LEAD_ID, MEMBER_ID } from '@/features/route/fixtures';
import type { FeedEntry } from './api';

export const ENTRY_ID = '0192f0a0-7c1e-7b3a-8d2f-00000000f001';

export function sampleEntry(overrides: Partial<FeedEntry> = {}): FeedEntry {
  return {
    id: ENTRY_ID,
    source: 'issue',
    ref: 'issue:12',
    title: 'Доработать API',
    url: 'https://github.com/teamforge-demo/notes/issues/12',
    userId: MEMBER_ID,
    roleCode: 'backend',
    stageOrdinal: 2,
    active: true,
    occurredAt: '2026-02-01T10:00:00.000Z',
    receivedAt: '2026-02-01T10:00:05.000Z',
    ...overrides,
  };
}

export function sampleSummary(): ContributionSummary {
  return {
    members: [
      {
        userId: MEMBER_ID,
        byRole: [
          { roleCode: 'backend', issues: 3, prs: 2, artifacts: 1, rituals: 0 },
          { roleCode: 'devops', issues: 1, prs: 0, artifacts: 0, rituals: 1 },
        ],
      },
      {
        userId: LEAD_ID,
        byRole: [{ roleCode: 'pm', issues: 0, prs: 0, artifacts: 2, rituals: 3 }],
      },
    ],
    unassignedItemIds: [],
  };
}
