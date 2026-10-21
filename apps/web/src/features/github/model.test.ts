import { describe, expect, it } from 'vitest';
import { githubRepositoryUrl, parseInstallationId, parseSetupError, safeInstallUrl } from './model';

describe('FR-GH-01: values taken from the return address', () => {
  it('accepts a positive integer installation and nothing else', () => {
    expect(parseInstallationId('424242')).toBe(424242);
    for (const bad of [undefined, '', '0', '-1', '1.5', '12abc', '9'.repeat(20)]) {
      expect(parseInstallationId(bad)).toBeNull();
    }
  });

  it('accepts only a short snake_case error code', () => {
    expect(parseSetupError('state_invalid')).toBe('state_invalid');
    expect(parseSetupError('<script>')).toBeNull();
    expect(parseSetupError(undefined)).toBeNull();
  });

  it('follows only https install addresses', () => {
    expect(safeInstallUrl('https://github.com/apps/x/installations/new?state=s')).toContain(
      'https://github.com/apps/x',
    );
    expect(safeInstallUrl('http://github.com/apps/x')).toBeNull();
    expect(safeInstallUrl('javascript:alert(1)')).toBeNull();
    expect(safeInstallUrl('not a url')).toBeNull();
  });

  it('builds the repository link only from a valid owner/name', () => {
    expect(githubRepositoryUrl('org/repo')).toBe('https://github.com/org/repo');
    expect(githubRepositoryUrl('org/../repo/x')).toBeNull();
  });
});
