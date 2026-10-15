import { describe, expect, it, vi } from 'vitest';
import { AutoAddService } from './auto-add.service.js';

const NOW = new Date('2026-01-15T12:00:00Z');
const seat = {
  seatId: 'seat-1',
  teamId: 'team-1',
  teamName: 'Rockets',
  roleCode: 'backend',
  minLevel: 'junior',
  minHours: 5,
  stack: ['typescript'],
  openedAt: NOW,
  teamTimezone: 'Europe/Moscow',
  teamHoursPerWeek: 10,
  leadUserId: 'lead',
  memberUserIds: ['lead'],
};

/** Three queued people, one open seat: the run reads each person's counters in ONE statement. */
function build() {
  const userIds = ['u1', 'u2', 'u3'];
  const completedByUsers = vi.fn((ids: string[]) =>
    Promise.resolve(new Map(ids.map((id) => [id, new Map([['backend', 2]])]))),
  );
  const completedByRole = vi.fn(() => Promise.resolve(new Map<string, number>()));
  const service = new AutoAddService(
    { now: () => NOW } as never,
    { run: (fn: () => Promise<unknown>) => fn() } as never,
    { lockSearchApplication: () => Promise.resolve() } as never,
    { publishMany: () => Promise.resolve() } as never,
    { lockUserForJoin: () => Promise.resolve({}) } as never,
    {
      getMatchingProfiles: (ids: string[]) =>
        Promise.resolve(
          ids.map((userId) => ({
            userId,
            timezone: 'Europe/Moscow',
            hoursPerWeek: 20,
            stack: ['typescript'],
            rolePrefs: [{ roleCode: 'backend', level: 'middle' }],
          })),
        ),
    } as never,
    { listOpenSeats: () => Promise.resolve([seat]) } as never,
    { find: () => Promise.resolve(undefined) } as never,
    {
      activeApplications: () =>
        Promise.resolve(userIds.map((userId, i) => ({ id: `a${i}`, userId, enqueuedAt: NOW }))),
      activeRoles: (ids: string[]) =>
        Promise.resolve(
          new Map(ids.map((id) => [id, [{ applicationId: id, roleCode: 'backend', priority: 1, addedAt: NOW }]])),
        ),
      exclusions: () => Promise.resolve(new Map()),
      insertLog: () => Promise.resolve(),
    } as never,
    { completedByUsers, completedByRole } as never,
  );
  return { service, completedByUsers, completedByRole };
}

describe('AutoAddService statements per page', () => {
  it('reads the completed projects of all people of a page at once, not one person at a time', async () => {
    const { service, completedByUsers, completedByRole } = build();
    const report = await service.run();
    expect(report.applications).toBe(3);
    expect(completedByUsers).toHaveBeenCalledTimes(1);
    expect(completedByUsers).toHaveBeenCalledWith(['u1', 'u2', 'u3']);
    expect(completedByRole).not.toHaveBeenCalled();
  });
});
