// Sample data for route / checklist component tests (typed by the generated contract).
import { LEAD_ID, MEMBER_ID, sampleTeam, TEAM_ID } from '@/features/teams/fixtures';
import type { Team } from '@/features/teams/api';
import type { ChecklistItem, Playbook, ProjectStage } from './api';

export { LEAD_ID, MEMBER_ID, TEAM_ID };

export const PLAYBOOK_ID = '0192f0a0-7c1e-7b3a-8d2f-00000000c001';
export const ITEM_ID = '0192f0a0-7c1e-7b3a-8d2f-00000000d001';
export const SPEC_ITEM_ID = '0192f0a0-7c1e-7b3a-8d2f-00000000d002';

export function activeTeam(overrides: Partial<Team> = {}): Team {
  const lead = sampleTeam().members[0]!;
  return sampleTeam({
    status: 'active',
    memberCount: 2,
    members: [
      lead,
      {
        ...lead,
        userId: MEMBER_ID,
        displayName: 'Борис Иванов',
        isLead: false,
        roles: ['backend'],
      },
    ],
    ...overrides,
  });
}

export function sampleStage(overrides: Partial<ProjectStage> = {}): ProjectStage {
  return {
    ordinal: 1,
    key: 'mini_s1',
    title: 'Этап 1. Старт',
    status: 'open',
    durationDays: 7,
    openedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    dueAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    closedAt: null,
    overdue: false,
    ...overrides,
  };
}

export function sampleItem(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    id: ITEM_ID,
    stageOrdinal: 1,
    stepKey: 'mini_kickoff',
    title: 'Kickoff команды',
    kind: 'ritual',
    submission: null,
    ritualKind: 'call',
    required: true,
    ownerRole: 'any',
    status: 'open',
    assigneeUserId: null,
    roleCode: null,
    fallbackUsed: false,
    fallback: null,
    linkUrl: null,
    linkStatus: 'none',
    heldOn: null,
    externalUrl: null,
    outcome: null,
    files: [],
    review: null,
    version: 3,
    updatedAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

export function sampleSpecItem(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return sampleItem({
    id: SPEC_ITEM_ID,
    stepKey: 'mini_spec',
    title: 'Спецификация',
    kind: 'artifact',
    submission: 'file',
    ritualKind: null,
    ownerRole: 'backend',
    assigneeUserId: MEMBER_ID,
    ...overrides,
  });
}

export function samplePlaybook(): Playbook {
  const step = {
    description: 'Документ со спецификацией первой версии.',
    type: 'artifact' as const,
    required: true,
    ownerRole: 'backend',
    altRoles: [],
    fallback: null,
    autoChecks: [],
    sources: [],
  };
  return {
    id: PLAYBOOK_ID,
    productTypeCode: 'web_service',
    title: 'Мини-сценарий',
    version: '1.0.0',
    status: 'published',
    totalDays: 28,
    stages: [
      {
        key: 'mini_s1',
        ordinal: 1,
        title: 'Этап 1. Старт',
        goal: 'Договориться о цели.',
        durationDays: 7,
        exitCriteria: 'Обязательные шаги выполнены.',
        steps: [
          {
            ...step,
            key: 'mini_spec',
            title: 'Спецификация',
            submission: 'file',
            reviewChecklist: true,
            reviewItems: ['Записаны цели и не-цели?', 'Описаны альтернативы?'],
          },
        ],
      },
    ],
  };
}
