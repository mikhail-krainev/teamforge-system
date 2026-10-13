'use client';

import Link from 'next/link';
import { t } from '@/i18n';
import { useMe } from './session';
import { useSignOut } from './useSignOut';

/** Header slot: "Sign in" for guests, "Sign out" for a signed-in user. Purely presentational. */
export function AccountMenu() {
  const me = useMe();
  const signOut = useSignOut();
  if (me.isPending) return <span className="muted">{t('auth.session.loading')}</span>;
  if (!me.data) {
    return (
      <Link className="button button-secondary" href="/sign-in">
        {t('auth.session.signIn')}
      </Link>
    );
  }
  return (
    <div className="row">
      <button
        type="button"
        className="button button-secondary"
        disabled={signOut.isPending}
        onClick={() => signOut.mutate()}
      >
        {signOut.isPending ? t('auth.session.signingOut') : t('auth.session.signOut')}
      </button>
      {signOut.isError ? (
        <span role="alert" className="field-error">
          {t('auth.session.signOutFailed')}
        </span>
      ) : null}
    </div>
  );
}
