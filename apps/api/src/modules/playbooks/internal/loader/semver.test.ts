import { describe, expect, it } from 'vitest';
import { compareSemver, parseSemver } from './semver.js';

const INT_MAX = 2_147_483_647;

describe('parseSemver (the version of a playbook, FR-PLAY-03)', () => {
  it.each(['0.0.0', '1.0.0', '9.12.345', '1.2.3'])('%s is a version', (value) => {
    expect(parseSemver(value)).not.toBeNull();
  });

  it('a part is as large as the integer column that stores it: epoch seconds (10 digits) are valid', () => {
    expect(parseSemver('9.1792250000.0')).toEqual({ major: 9, minor: 1_792_250_000, patch: 0 });
    expect(parseSemver(`${INT_MAX}.${INT_MAX}.${INT_MAX}`)).toEqual({
      major: INT_MAX,
      minor: INT_MAX,
      patch: INT_MAX,
    });
  });

  it.each([
    [`${INT_MAX + 1}.0.0`],
    [`0.${INT_MAX + 1}.0`],
    [`0.0.${INT_MAX + 1}`],
    ['0.0.99999999999'],
  ])('%s does not fit the integer column', (value) => {
    expect(parseSemver(value)).toBeNull();
  });

  it.each([
    [''],
    ['1'],
    ['1.0'],
    ['1.0.0.0'],
    ['01.0.0'],
    ['1.00.0'],
    ['1.0.00'],
    ['1.0.0-beta'],
    ['1.0.0+build'],
    ['v1.0.0'],
    [' 1.0.0'],
    ['1.0.0 '],
    ['1.0.0\n'],
    ['-1.0.0'],
    ['1.a.0'],
    ['１.0.0'],
  ])('%j is not MAJOR.MINOR.PATCH', (value) => {
    expect(parseSemver(value)).toBeNull();
  });
});

describe('compareSemver', () => {
  const v = (text: string) => {
    const parsed = parseSemver(text);
    if (parsed === null) throw new Error(text);
    return parsed;
  };

  it('compares numerically part by part, not as text: 1.10.0 is above 1.9.0', () => {
    expect(compareSemver(v('1.10.0'), v('1.9.0'))).toBeGreaterThan(0);
    expect(compareSemver(v('2.0.0'), v('1.99.99'))).toBeGreaterThan(0);
    expect(compareSemver(v('1.0.1'), v('1.0.0'))).toBeGreaterThan(0);
  });

  it('is zero for the same version and negative for a lower one', () => {
    expect(compareSemver(v('3.4.5'), v('3.4.5'))).toBe(0);
    expect(compareSemver(v('3.4.5'), v('3.4.6'))).toBeLessThan(0);
  });
});
