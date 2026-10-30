'use client';

import Link from 'next/link';
import { t } from '@/i18n';
import { useMe } from './session';
import { useSignOut } from './useSignOut';

function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" focusable="false" width="16" height="16">
      <path
        d="M4 12L12 4M5.5 4H12v6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Header slot: "Sign in" for guests; avatar, name and "Sign out" for a signed-in user. */
export function AccountMenu() {
  const me = useMe();
  const signOut = useSignOut();
  if (me.isPending) return <span className="muted">{t('auth.session.loading')}</span>;
  if (!me.data) {
    return (
      <Link className="account-cta" href="/sign-in">
        <span className="button button-small">{t('auth.session.signIn')}</span>
        <span className="arrow-dot" aria-hidden="true">
          <ArrowIcon />
        </span>
      </Link>
    );
  }
  const name = me.data.displayName?.trim();
  return (
    <div className="account">
      {name ? (
        <span className="account-pill">
          <span className="avatar" aria-hidden="true">
            {name.slice(0, 1).toUpperCase()}
          </span>
          <span className="account-name">{name}</span>
        </span>
      ) : null}
      <button
        type="button"
        className="button button-small button-secondary"
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
