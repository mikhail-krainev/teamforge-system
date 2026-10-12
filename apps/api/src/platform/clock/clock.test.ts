import { describe, expect, it } from 'vitest';
import { FixedClock, SystemClock } from './clock.js';

describe('Clock', () => {
  it('SystemClock returns the current time', () => {
    const before = Date.now();
    const value = new SystemClock().now().getTime();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(Date.now());
  });

  it('FixedClock stays still until moved and returns copies', () => {
    const clock = new FixedClock('2026-03-01T10:00:00.000Z');
    const first = clock.now();
    first.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-03-01T10:00:00.000Z');
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe('2026-03-01T10:01:00.000Z');
    clock.set('2027-01-01T00:00:00.000Z');
    expect(clock.now().getUTCFullYear()).toBe(2027);
  });
});
