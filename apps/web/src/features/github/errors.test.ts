import { describe, expect, it } from 'vitest';
import { t } from '@/i18n';
import { setupErrorText } from './errors';

describe('FR-GH-01: texts of the ?error= codes of the installation redirect', () => {
  it.each([
    'not_lead',
    'account_mismatch',
    'permissions_missing',
    'installation_suspended',
    'github_unavailable',
  ])('%s has its own Russian text, not the unknown one', (code) => {
    const text = setupErrorText(code);
    expect(text).not.toBe(t('github.setup.errors.unknown'));
    expect(text).toMatch(/[а-яё]/i);
  });

  it('an unrecognised code falls back to the unknown text', () => {
    expect(setupErrorText('something_new')).toBe(t('github.setup.errors.unknown'));
    expect(setupErrorText(null)).toBe(t('github.setup.errors.unknown'));
  });
});
