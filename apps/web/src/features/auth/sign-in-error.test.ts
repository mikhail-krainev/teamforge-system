import { describe, expect, it } from 'vitest';
import { t } from '@/i18n';
import { signInErrorMessage } from './sign-in-error';

describe('signInErrorMessage', () => {
  it('shows nothing without an error code', () => {
    expect(signInErrorMessage(undefined)).toBeNull();
    expect(signInErrorMessage('')).toBeNull();
  });

  it('asks to restart when the state cookie was lost (another browser, cookie refused)', () => {
    expect(signInErrorMessage('state_mismatch')).toBe(t('auth.signIn.githubRestart'));
  });

  it('says the sign-in was cancelled when the user declined on GitHub', () => {
    expect(signInErrorMessage('access_denied')).toBe(t('auth.signIn.githubCancelled'));
  });

  it('falls back to a general message for any other code', () => {
    expect(signInErrorMessage('invalid_code')).toBe(t('auth.signIn.githubFailed'));
  });
});
