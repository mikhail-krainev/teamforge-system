import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { resultData, sampleCheck } from './fixtures';
import {
  checkTitle,
  finishErrorText,
  formatRemaining,
  isCheckGreen,
  reasonText,
  retryAtOf,
  unmetFromError,
  unmetText,
} from './model';

const NOW = new Date('2026-03-01T10:00:00.000Z');
const result = (data?: Record<string, unknown>) => ({
  key: 'release_alive_web',
  ok: false,
  blocking: true,
  message: 'x',
  ...(data ? { data: resultData(data) } : {}),
});

describe('FR-WORK-13: when "Завершить проект" is offered', () => {
  it('needs a finished, still valid check without a blocking failure', () => {
    const valid = new Date(NOW.getTime() + 60_000).toISOString();
    expect(isCheckGreen(sampleCheck({ validUntil: valid }), NOW)).toBe(true);
    expect(isCheckGreen(null, NOW)).toBe(false);
    expect(isCheckGreen(sampleCheck({ status: 'running', validUntil: valid }), NOW)).toBe(false);
    expect(isCheckGreen(sampleCheck({ validUntil: NOW.toISOString() }), NOW)).toBe(false);
    expect(isCheckGreen(sampleCheck({ validUntil: null }), NOW)).toBe(false);
  });

  it('a failed signal check does not block, a failed blocking one does', () => {
    const valid = new Date(NOW.getTime() + 60_000).toISOString();
    const soft = { key: 'sha_dedup', ok: false, blocking: false, message: 'x' };
    expect(isCheckGreen(sampleCheck({ validUntil: valid, results: [soft] }), NOW)).toBe(true);
    expect(isCheckGreen(sampleCheck({ validUntil: valid, results: [result()] }), NOW)).toBe(false);
  });
});

describe('FR-WORK-14: the reason and the time of the second release check', () => {
  it('reads the reason only from a known code, never free text', () => {
    expect(reasonText(result({ reason: 'TOO_SMALL' }))).toBe('страница слишком маленькая');
    expect(reasonText(result({ reason: '<b>boom</b>' }))).toBeNull();
    expect(reasonText(result())).toBeNull();
  });

  it('finds the moment of the next check among the known fields', () => {
    expect(retryAtOf(result({ retryAt: '2026-03-02T10:00:00.000Z' }))?.toISOString()).toBe(
      '2026-03-02T10:00:00.000Z',
    );
    expect(retryAtOf(result({ retryAt: 'not a date' }))).toBeNull();
    expect(retryAtOf(result())).toBeNull();
  });

  it('formats the time left in hours and minutes', () => {
    expect(formatRemaining(23 * 3_600_000 + 59 * 60_000)).toBe('23 ч 59 мин');
    expect(formatRemaining(45 * 60_000)).toBe('45 мин');
    expect(formatRemaining(1)).toBe('1 мин');
  });
});

describe('texts', () => {
  it('names a known check and falls back for an unknown one', () => {
    expect(checkTitle('repo_final')).toBe('Репозиторий готов');
    expect(checkTitle('link_https')).toBe('Ссылки шагов работают');
    expect(checkTitle('something_new')).toBe('Другая проверка');
  });

  it('takes the unmet list only from a COMPLETION_BLOCKED refusal', () => {
    const blocked = new ApiError({
      status: 409,
      body: undefined,
      problem: {
        status: 409,
        code: 'COMPLETION_BLOCKED',
        unmet: [{ code: 'STAGES_NOT_CLOSED', message: 'x' }],
      },
    });
    expect(unmetFromError(blocked)).toEqual([{ code: 'STAGES_NOT_CLOSED', message: 'x' }]);
    expect(
      unmetFromError(
        new ApiError({
          status: 409,
          body: undefined,
          problem: { status: 409, code: 'INVALID_STATE' },
        }),
      ),
    ).toBeNull();
    expect(unmetText({ code: 'STAGES_NOT_CLOSED' })).toBe('Пройдены не все этапы.');
    expect(unmetText({ code: 'BRAND_NEW', message: 'Текст сервера' })).toBe('Текст сервера');
  });

  it('explains a repeated completion', () => {
    const again = new ApiError({
      status: 409,
      body: undefined,
      problem: { status: 409, code: 'INVALID_STATE' },
    });
    expect(finishErrorText(again)).toContain('уже завершён');
  });
});
