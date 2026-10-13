import { describe, expect, it } from 'vitest';
import { pickConfirmed, suggestedFields } from './suggestions';

const suggestions = {
  displayName: 'Анна',
  stack: ['react'],
  strengths: [],
  rolePrefs: [{ roleCode: 'frontend', level: 'junior' as const }],
};

describe('resume suggestions', () => {
  it('lists only fields that have a value', () => {
    expect(suggestedFields(suggestions)).toEqual(['displayName', 'rolePrefs', 'stack']);
    expect(suggestedFields(null)).toEqual([]);
  });

  it('sends only the ticked fields', () => {
    expect(pickConfirmed(suggestions, new Set(['stack']))).toEqual({ stack: ['react'] });
    expect(pickConfirmed(suggestions, new Set())).toEqual({});
  });

  it('ignores a ticked field the parser did not suggest', () => {
    expect(pickConfirmed(suggestions, new Set(['strengths']))).toEqual({});
  });
});
