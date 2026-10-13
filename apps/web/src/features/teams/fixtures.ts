// Sample data for team component tests (typed by the generated contract).
import { ROLES } from '@/mocks/slice2/db';
import type { ProductType, Seat, Team, TeamSummary } from './api';

export const TEAM_ID = '0192f0a0-7c1e-7b3a-8d2f-00000000a001';
export const LEAD_ID = '0192f0a0-7c1e-7b3a-8d2f-3a4b5c6d7e8f';
export const MEMBER_ID = '0192f0a0-7c1e-7b3a-8d2f-0000000000aa';
export const SEAT_ID = '0192f0a0-7c1e-7b3a-8d2f-00000000b001';
export const ROLE_LIST = ROLES;

export const PRODUCT_TYPES: ProductType[] = [
  { code: 'web_service', name: 'Веб-сервис', active: true },
  { code: 'ml_product', name: 'ML-продукт', active: true },
];

export function sampleSeat(overrides: Partial<Seat> = {}): Seat {
  return {
    id: SEAT_ID,
    roleCode: 'backend',
    desired: false,
    minLevel: 'junior',
    minHours: 10,
    stack: ['node'],
    ordinal: 1,
    status: 'open',
    holderUserId: null,
    version: 3,
    ...overrides,
  };
}

export function sampleTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: TEAM_ID,
    name: 'Команда Альфа',
    description: 'Делаем сервис для заметок',
    timezone: 'Europe/Moscow',
    hoursPerWeek: 12,
    productTypeCode: 'web_service',
    playbookId: '0192f0a0-7c1e-7b3a-8d2f-00000000c001',
    playbookVersion: '1.0.0',
    leadUserId: LEAD_ID,
    status: 'forming',
    memberCount: 1,
    seats: [sampleSeat()],
    members: [
      {
        userId: LEAD_ID,
        displayName: 'Анна Смирнова',
        status: 'active',
        joinedVia: 'creator',
        joinedAt: '2026-01-01T10:00:00.000Z',
        trialUntil: null,
        roles: ['pm'],
        isLead: true,
      },
    ],
    version: 1,
    createdAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

export function sampleSummary(overrides: Partial<TeamSummary> = {}): TeamSummary {
  return {
    id: TEAM_ID,
    name: 'Команда Альфа',
    productTypeCode: 'web_service',
    status: 'forming',
    timezone: 'Europe/Moscow',
    hoursPerWeek: 12,
    memberCount: 1,
    openSeats: [{ seatId: SEAT_ID, roleCode: 'backend', minLevel: 'junior', desired: false }],
    ...overrides,
  };
}
