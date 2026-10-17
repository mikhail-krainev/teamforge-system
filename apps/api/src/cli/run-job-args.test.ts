import { describe, expect, it } from 'vitest';
import { CLI_JOB_NAMES } from '../platform/queues/cli-jobs.js';
import { parseRunJobArgs } from './run-job-args.js';

describe('parseRunJobArgs', () => {
  it('accepts every job of the closed list', () => {
    for (const name of CLI_JOB_NAMES)
      expect(parseRunJobArgs([name])).toEqual({ ok: true, job: name });
  });

  it('knows matching-auto-add', () => {
    expect(CLI_JOB_NAMES).toContain('matching-auto-add');
  });

  it('refuses a missing name and lists the allowed jobs', () => {
    const result = parseRunJobArgs([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('matching-auto-add');
  });

  it.each([
    'unknown-job',
    'MATCHING-AUTO-ADD',
    ' matching-auto-add',
    'matching-auto-add;id',
    '--help',
    '',
    '__proto__',
    'constructor',
  ])('refuses the unknown name %j', (name) => {
    expect(parseRunJobArgs([name]).ok).toBe(false);
  });

  it('refuses extra arguments, also after a valid name', () => {
    expect(parseRunJobArgs(['matching-auto-add', 'matching-auto-add']).ok).toBe(false);
    expect(parseRunJobArgs(['matching-auto-add', '--force']).ok).toBe(false);
  });

  it('cuts a very long name in the message', () => {
    const result = parseRunJobArgs(['x'.repeat(5000)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeLessThan(200);
  });
});
