import { describe, expect, it } from 'vitest';
import {
  emptySeat,
  emptyTeamDraft,
  firstInvalidId,
  toTeamCreate,
  validateTeamDraft,
} from './model';

const valid = () => ({
  ...emptyTeamDraft('Europe/Moscow'),
  name: 'Команда',
  productTypeCode: 'web_service',
});

describe('team draft validation', () => {
  it('accepts a minimal valid draft', () => {
    expect(validateTeamDraft(valid())).toEqual({});
  });

  it('reports name, product type and hours', () => {
    const errors = validateTeamDraft({
      ...valid(),
      name: 'ab',
      productTypeCode: '',
      hoursPerWeek: '2',
    });
    expect(Object.keys(errors).sort()).toEqual(['hoursPerWeek', 'name', 'productTypeCode']);
  });

  it('validates seats and the 12 seat total', () => {
    const seats = [
      { ...emptySeat(), roleCode: 'pm', count: '7' },
      { ...emptySeat(), roleCode: 'qa', count: '6' },
    ];
    expect(validateTeamDraft({ ...valid(), seats }).seats).toBe('teams.errors.seatsTooMany');
    const bad = validateTeamDraft({ ...valid(), seats: [emptySeat()] });
    expect(bad['seat-0-roleCode']).toBe('teams.errors.roleRequired');
  });

  it('finds the first invalid id in visual order', () => {
    expect(
      firstInvalidId({ hoursPerWeek: 'teams.errors.hours', name: 'teams.errors.name' }, [
        'name',
        'hoursPerWeek',
      ]),
    ).toBe('name');
  });

  it('builds the request body with numbers and trimmed text', () => {
    const body = toTeamCreate({
      ...valid(),
      name: '  Команда  ',
      seats: [{ ...emptySeat(), roleCode: 'pm' }],
    });
    expect(body.name).toBe('Команда');
    expect(body.hoursPerWeek).toBe(10);
    expect(body.seats?.[0]).toMatchObject({
      roleCode: 'pm',
      minHours: 10,
      count: 1,
      desired: false,
    });
  });
});
