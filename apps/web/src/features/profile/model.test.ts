import { describe, expect, it } from 'vitest';
import { sampleProfile } from '@/mocks/slice2/db';
import { emptyDraft, splitLines, toDraft, toInput, validateDraft } from './model';

describe('profile draft', () => {
  it('round-trips a stored profile through the form model', () => {
    const profile = sampleProfile();
    const input = toInput(toDraft(profile), profile.version);
    expect(input).toMatchObject({
      displayName: profile.displayName,
      hoursPerWeek: 12,
      stack: ['react', 'typescript'],
      rolePrefs: [{ roleCode: 'frontend', level: 'junior' }],
      strengths: ['Внимательность'],
      version: 1,
    });
    expect(input.experience[0]).toMatchObject({ title: 'Учебный проект', to: null });
  });

  it('sends version null on the first save and null for an empty portfolio', () => {
    const draft = { ...emptyDraft('Europe/Moscow'), displayName: 'Иван' };
    expect(toInput(draft, null)).toMatchObject({ version: null, portfolioUrl: null });
  });

  it('splits multi-line lists, dropping blanks', () => {
    expect(splitLines(' a \n\n b\n')).toEqual(['a', 'b']);
  });
});

describe('validateDraft', () => {
  const valid = { ...emptyDraft('Europe/Moscow'), displayName: 'Иван' };

  it('accepts a minimal valid draft', () => {
    expect(validateDraft(valid)).toEqual({});
  });

  it('checks name, hours and portfolio limits', () => {
    const errors = validateDraft({
      ...valid,
      displayName: 'И',
      hoursPerWeek: '41',
      portfolioUrl: 'http://x.ru',
    });
    expect(errors).toMatchObject({
      displayName: 'profile.errors.name',
      hoursPerWeek: 'profile.errors.hours',
      portfolioUrl: 'profile.errors.url',
    });
    expect(validateDraft({ ...valid, hoursPerWeek: '2.5' }).hoursPerWeek).toBeDefined();
  });

  it('checks experience rows individually', () => {
    const errors = validateDraft({
      ...valid,
      experience: [
        { title: '', description: '', from: '', to: '' },
        { title: 'A', description: '', from: '2025-05-01', to: '2025-01-01' },
      ],
    });
    expect(errors['experience.0.title']).toBe('profile.errors.required');
    expect(errors['experience.0.from']).toBe('profile.errors.required');
    expect(errors['experience.1.to']).toBe('profile.errors.dateOrder');
  });

  it('limits strengths to 10 lines of 200 characters', () => {
    const tooMany = Array(11).fill('x').join('\n');
    expect(validateDraft({ ...valid, strengths: tooMany }).strengths).toBe(
      'profile.errors.listTooLong',
    );
    expect(validateDraft({ ...valid, weaknesses: 'x'.repeat(201) }).weaknesses).toBe(
      'profile.errors.itemTooLong',
    );
  });
});
