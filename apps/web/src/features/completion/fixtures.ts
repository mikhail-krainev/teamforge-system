// Sample data for the completion tests (typed by the generated contract).
import type { Completion, CompletionCheck, CompletionCheckResult } from './api';

export const CHECK_ID = '0192f0a0-7c1e-7b3a-8d2f-00000000e001';

const HOUR_MS = 3_600_000;

export function sampleCheck(overrides: Partial<CompletionCheck> = {}): CompletionCheck {
  const finishedAt = new Date().toISOString();
  return {
    id: CHECK_ID,
    status: 'done',
    requestedAt: finishedAt,
    finishedAt,
    validUntil: new Date(Date.now() + HOUR_MS).toISOString(),
    results: [
      { key: 'repo_final', ok: true, blocking: true, message: 'ok' },
      { key: 'release_alive_web', ok: true, blocking: true, message: 'ok' },
    ],
    ...overrides,
  };
}

export function sampleCompletion(overrides: Partial<Completion> = {}): Completion {
  return {
    teamId: '0192f0a0-7c1e-7b3a-8d2f-00000000a001',
    completedAt: '2026-03-01T10:00:00.000Z',
    plannedEndAt: '2026-03-05T10:00:00.000Z',
    overdueDays: 0,
    onTime: true,
    credit: { status: 'cooling', coolingUntil: '2026-03-15T10:00:00.000Z' },
    ...overrides,
  };
}

/** The contract types `data` as an empty record; the worker puts a reason code and a status into it. */
export const resultData = (data: Record<string, unknown>) => data as CompletionCheckResult['data'];
