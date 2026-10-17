import { describe, expect, it } from 'vitest';
import {
  completionIssue,
  executorRole,
  fallbackAfterDeparture,
  heldOnIssue,
  type ItemFacts,
} from './item-rules.js';

const ctx = { today: '2026-10-17', stageOpenedOn: '2026-10-10' };
const blank: ItemFacts = {
  kind: 'artifact',
  submission: 'link',
  linkUrl: null,
  heldOn: null,
  externalUrl: null,
  outcome: null,
  filesCount: 0,
};

describe('completionIssue', () => {
  it('a ritual lists every missing field', () => {
    const issue = completionIssue({ ...blank, kind: 'ritual', submission: null }, ctx);
    expect(issue).toMatchObject({
      code: 'RITUAL_FIELDS_REQUIRED',
      pointers: ['/heldOn', '/externalUrl', '/outcome'],
    });
  });

  it('a complete ritual passes; a day in the future or before the stage does not', () => {
    const ritual: ItemFacts = {
      ...blank,
      kind: 'ritual',
      submission: null,
      heldOn: '2026-10-15',
      externalUrl: 'https://meet.example.test/r',
      outcome: 'Итоги встречи записаны полностью.',
    };
    expect(completionIssue(ritual, ctx)).toBeUndefined();
    expect(completionIssue({ ...ritual, heldOn: '2026-10-18' }, ctx)?.code).toBe(
      'VALIDATION_FAILED',
    );
    expect(completionIssue({ ...ritual, heldOn: '2026-10-09' }, ctx)?.code).toBe(
      'VALIDATION_FAILED',
    );
    expect(heldOnIssue('2026-10-10', ctx)).toBeUndefined();
    expect(heldOnIssue('2026-10-17', ctx)).toBeUndefined();
  });

  it.each([
    ['link', { linkUrl: 'https://a.example.test/' }, true],
    ['link', { filesCount: 1 }, false],
    ['file', { filesCount: 1 }, true],
    ['file', { linkUrl: 'https://a.example.test/' }, false],
    ['either', { linkUrl: 'https://a.example.test/' }, true],
    ['either', { filesCount: 2 }, true],
    ['either', {}, false],
  ])('an artifact with submission %s and %j: closable %s', (submission, have, closable) => {
    const issue = completionIssue({ ...blank, submission, ...have }, ctx);
    expect(issue === undefined).toBe(closable);
  });
});

describe('executorRole', () => {
  const step = { ownerRole: 'pm', altRoles: ['ba'] };
  it('owner role first, then the alternative, otherwise none', () => {
    expect(executorRole(step, ['ba', 'pm'])).toBe('pm');
    expect(executorRole(step, ['ba'])).toBe('ba');
    expect(executorRole(step, ['qa'])).toBeNull();
  });
});

describe('fallbackAfterDeparture', () => {
  const step = { ownerRole: 'backend', altRoles: ['devops'] };
  it('the last holder left: the step goes to the fallback', () => {
    expect(fallbackAfterDeparture(step, false, [{ roles: ['frontend'] }])).toBe(true);
  });
  it('somebody still holds the owner or an alternative role: unchanged', () => {
    expect(fallbackAfterDeparture(step, false, [{ roles: ['backend'] }])).toBe(false);
    expect(fallbackAfterDeparture(step, false, [{ roles: ['devops'] }])).toBe(false);
  });
  it('a step for any member never needs a fallback; a used fallback stays', () => {
    expect(fallbackAfterDeparture({ ownerRole: 'any', altRoles: [] }, false, [])).toBe(false);
    expect(fallbackAfterDeparture(step, true, [{ roles: ['backend'] }])).toBe(true);
  });
});
