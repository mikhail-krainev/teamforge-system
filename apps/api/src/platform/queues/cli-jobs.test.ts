import { describe, expect, it } from 'vitest';
import { CliJobs, isCliJobName } from './cli-jobs.js';

describe('CliJobs', () => {
  it('runs a registered job and refuses a second registration', async () => {
    const jobs = new CliJobs();
    jobs.register('matching-auto-add', () => Promise.resolve({ added: 1 }));
    await expect(jobs.get('matching-auto-add')?.()).resolves.toEqual({ added: 1 });
    expect(() => jobs.register('matching-auto-add', () => Promise.resolve(0))).toThrow(
      /already exists/,
    );
  });

  it('has no runner for a job nobody registered', () => {
    expect(new CliJobs().get('matching-auto-add')).toBeUndefined();
  });

  it('isCliJobName accepts only the closed list', () => {
    expect(isCliJobName('matching-auto-add')).toBe(true);
    expect(isCliJobName('toString')).toBe(false);
  });
});
