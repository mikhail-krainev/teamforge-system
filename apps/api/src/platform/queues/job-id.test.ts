import { describe, expect, it } from 'vitest';
import { assertValidJobId, InvalidJobIdError, jobId } from './job-id.js';
import { defaultJobOptions, QUEUE_DEFINITIONS } from './queue-definitions.js';

describe('jobId', () => {
  it('joins parts with underscores', () => {
    expect(jobId('credit', '0192f1c2-aaaa-7bbb-8ccc-0123456789ab')).toBe(
      'credit_0192f1c2-aaaa-7bbb-8ccc-0123456789ab',
    );
    expect(jobId('recompute', 'user-1', 5)).toBe('recompute_user-1_5');
  });

  it('rejects ":" in any part', () => {
    expect(() => jobId('a:b')).toThrow(InvalidJobIdError);
    expect(() => jobId('a', 'b:c', 'd')).toThrow(InvalidJobIdError);
  });

  it('rejects integer-like ids and empty parts', () => {
    expect(() => jobId('12345')).toThrow(InvalidJobIdError);
    expect(() => jobId(7)).toThrow(InvalidJobIdError);
    expect(() => jobId('a', '')).toThrow(InvalidJobIdError);
    expect(() => jobId()).toThrow(InvalidJobIdError);
  });

  it('validates ids built elsewhere', () => {
    expect(() => assertValidJobId('ok_id')).not.toThrow();
    expect(() => assertValidJobId('a:b:c')).toThrow(InvalidJobIdError);
    expect(() => assertValidJobId('99')).toThrow(InvalidJobIdError);
  });
});

describe('queue definitions (architecture 13.12)', () => {
  it('uses the documented concurrency and attempts', () => {
    expect(QUEUE_DEFINITIONS.events).toMatchObject({ concurrency: 20, attempts: 5 });
    expect(QUEUE_DEFINITIONS['matching-auto-add'].concurrency).toBe(1);
    expect(QUEUE_DEFINITIONS['link-check'].attempts).toBe(3);
    expect(QUEUE_DEFINITIONS['resume-parse'].redis).toBe('resume');
  });

  it('drops completed matching jobs so time-windowed ids can be re-added', () => {
    expect(defaultJobOptions('matching-recompute').removeOnComplete).toBe(true);
    expect(defaultJobOptions('timers').removeOnComplete).toEqual({ age: 86_400 });
    expect(defaultJobOptions('timers').removeOnFail).toEqual({ age: 604_800 });
  });
});
