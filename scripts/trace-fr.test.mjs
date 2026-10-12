import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIncoming, testTitles } from './trace-fr.mjs';

test('trace-fr: expands ranges and ignores parenthetical remarks', () => {
  const line =
    '**Входящие FR.** FR-AUTH-01..03, FR-AUTH-06 (FR-AUTH-05 - срез 3), CC-1, CC-4 (часть "Старт"). Операции: см. таблицу (25).';
  assert.deepEqual(parseIncoming(line), [
    'CC-1',
    'CC-4',
    'FR-AUTH-01',
    'FR-AUTH-02',
    'FR-AUTH-03',
    'FR-AUTH-06',
  ]);
});

test('trace-fr: slice 1 owns FR-WORK-08 only', () => {
  const line =
    '**Входящие FR.** Нефункциональные требования spec 5.1-5.6, 5.9; FR-WORK-08 (идемпотентность) на уровне инфраструктуры; операции `healthLive`.';
  assert.deepEqual(parseIncoming(line), ['FR-WORK-08']);
});

test('trace-fr: reads identifiers from test titles only, not from comments or bodies', () => {
  const source = [
    '// FR-WORK-01 in a comment',
    "describeInfra('S1-06 FR-WORK-08 idempotency', ['db'], () => {",
    "  it('CC-7: one winner', () => { const x = 'FR-WORK-02'; });",
    '  test.step("1. open", () => {});',
    '});',
  ].join('\n');
  const titles = testTitles(source).join('\n');
  assert.match(titles, /FR-WORK-08/);
  assert.match(titles, /CC-7/);
  assert.doesNotMatch(titles, /FR-WORK-01|FR-WORK-02/);
});
