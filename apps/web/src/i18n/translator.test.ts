import { describe, expect, it } from 'vitest';
import { t } from '@/i18n';
import { createTranslator, flatten } from './translator';

const messages = {
  'members.count':
    '{count, plural, one {# участник} few {# участника} many {# участников} other {# участника}}',
  'greeting': 'Привет, {name}!',
} as const;
const { t: tt, has } = createTranslator<keyof typeof messages>(messages);

describe('createTranslator', () => {
  it.each([
    [0, '0 участников'],
    [1, '1 участник'],
    [2, '2 участника'],
    [4, '4 участника'],
    [5, '5 участников'],
    [11, '11 участников'],
    [21, '21 участник'],
    [22, '22 участника'],
    [111, '111 участников'],
    [1.5, '1,5 участника'],
  ])('plural for %s', (count, expected) => {
    expect(tt('members.count', { count })).toBe(expected);
  });

  it('substitutes params', () => {
    expect(tt('greeting', { name: 'Аня' })).toBe('Привет, Аня!');
  });

  it('returns the key for an unknown message and reports it via has()', () => {
    expect(tt('missing' as 'greeting')).toBe('missing');
    expect(has('greeting')).toBe(true);
    expect(has('missing')).toBe(false);
  });
});

describe('dictionaries', () => {
  it('flattens nested objects into dotted keys', () => {
    expect(flatten({ a: { b: 'x' }, c: 'y' })).toEqual({ 'a.b': 'x', c: 'y' });
  });

  it('loads real dictionaries with plurals', () => {
    expect(t('status.ok')).toBe('API работает');
    expect(t('errors.retryIn', { seconds: 2 })).toBe('Повторите через 2 секунды.');
    expect(t('errors.retryIn', { seconds: 5 })).toBe('Повторите через 5 секунд.');
  });
});
