// In-memory state behind the slice 2 mock handlers (auth, consent, profile, resume, deletion).
// Plain TypeScript without path aliases: it is also loaded by scripts/mock-api.mjs.
import type { Schema } from 'shared';

export type Profile = Schema<'Profile'>;
export type ResumeUpload = Schema<'ResumeUpload'>;

export const MOCK_USER_ID = '0192f0a0-7c1e-7b3a-8d2f-3a4b5c6d7e8f';
export const OTHER_USER_ID = '0192f0a0-7c1e-7b3a-8d2f-0000000000aa';
export const CONSENT_HASH = 'a'.repeat(64);

export const ROLES = [
  { code: 'pm', name: 'Менеджер проекта', active: true },
  { code: 'frontend', name: 'Frontend-разработчик', active: true },
  { code: 'backend', name: 'Backend-разработчик', active: true },
  { code: 'mobile', name: 'Мобильный разработчик', active: true },
  { code: 'designer', name: 'Дизайнер', active: true },
  { code: 'qa', name: 'Тестировщик', active: true },
];

export const STACK_TAGS = [
  'react',
  'typescript',
  'javascript',
  'node',
  'python',
  'go',
  'java',
  'kotlin',
  'swift',
  'docker',
  'postgresql',
  'figma',
].map((code) => ({ code, name: code, active: true }));

export interface MockDb {
  signedIn: boolean;
  consentAccepted: boolean;
  githubLinked: boolean;
  profile: Profile | null;
  resume: ResumeUpload | null;
  resumePolls: number;
  deletionRequested: boolean;
  magicLinkRequests: number;
}

export function createMockDb(overrides: Partial<MockDb> = {}): MockDb {
  return {
    signedIn: false,
    consentAccepted: false,
    githubLinked: false,
    profile: null,
    resume: null,
    resumePolls: 0,
    deletionRequested: false,
    magicLinkRequests: 0,
    ...overrides,
  };
}

export function sampleProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    userId: MOCK_USER_ID,
    displayName: 'Анна Смирнова',
    timezone: 'Europe/Moscow',
    hoursPerWeek: 12,
    portfolioUrl: 'https://example.com/anna',
    stack: ['react', 'typescript'],
    rolePrefs: [{ roleCode: 'frontend', level: 'junior' }],
    experience: [
      { title: 'Учебный проект', description: 'Интернет-магазин', from: '2025-09-01', to: null },
    ],
    strengths: ['Внимательность'],
    weaknesses: ['Дедлайны'],
    version: 1,
    updatedAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}
