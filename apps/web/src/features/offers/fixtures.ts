// Sample data for offer / departure component tests (typed by the generated contract).
import type { Departure, SeatOffer } from './api';

export const OFFER_ID = '0192f0a0-7c1e-7b3a-8d2f-00000000d001';
export const OTHER_USER_ID = '0192f0a0-7c1e-7b3a-8d2f-0000000000bb';
export const DEPARTURE_ID = '0192f0a0-7c1e-7b3a-8d2f-00000000f001';

export function sampleOffer(overrides: Partial<SeatOffer> = {}): SeatOffer {
  return {
    id: OFFER_ID,
    teamId: '0192f0a0-7c1e-7b3a-8d2f-00000000a001',
    seatId: '0192f0a0-7c1e-7b3a-8d2f-00000000b001',
    roleCode: 'backend',
    direction: 'lead_to_user',
    userId: OTHER_USER_ID,
    status: 'pending',
    message: 'Приходите к нам',
    expiresAt: '2026-02-01T10:00:00.000Z',
    createdAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

export function sampleDeparture(overrides: Partial<Departure> = {}): Departure {
  return {
    id: DEPARTURE_ID,
    userId: OTHER_USER_ID,
    seatIds: ['0192f0a0-7c1e-7b3a-8d2f-00000000b001'],
    roleCodes: ['backend'],
    reason: 'left',
    decision: 'pending',
    dueAt: '2026-02-01T10:00:00.000Z',
    decidedAt: null,
    unassignedItemIds: [],
    ...overrides,
  };
}
