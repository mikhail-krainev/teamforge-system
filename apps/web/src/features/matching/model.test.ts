import { describe, expect, it } from 'vitest';
import { orderedRoleCodes, toApplicationRoles, waitText } from './model';
import { sampleApplication } from './fixtures';

describe('matching model', () => {
  it('orders roles by priority and numbers them without gaps', () => {
    const app = sampleApplication({
      roles: [
        { roleCode: 'qa', priority: 2, addedAt: '2026-01-01T10:00:00.000Z' },
        { roleCode: 'backend', priority: 1, addedAt: '2026-01-01T10:00:00.000Z' },
      ],
    });
    expect(orderedRoleCodes(app)).toEqual(['backend', 'qa']);
    expect(toApplicationRoles(['backend', 'qa'])).toEqual([
      { roleCode: 'backend', priority: 1 },
      { roleCode: 'qa', priority: 2 },
    ]);
  });

  it('describes the average wait in days, hours or "not enough data"', () => {
    expect(waitText({ avgWaitSeconds: 3 * 86_400, avgWaitStatus: 'ok' })).toBe('около 3 дн.');
    expect(waitText({ avgWaitSeconds: 5 * 3600, avgWaitStatus: 'ok' })).toBe('около 5 ч');
    expect(waitText({ avgWaitSeconds: 600, avgWaitStatus: 'ok' })).toBe('меньше часа');
    expect(waitText({ avgWaitSeconds: null, avgWaitStatus: 'insufficient_data' })).toBe(
      'мало данных',
    );
  });
});
