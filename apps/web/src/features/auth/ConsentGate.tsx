'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { t } from '@/i18n';
import { ConsentScreen } from './ConsentScreen';
import { useMe } from './session';

/**
 * Wraps the signed-in part of the app. Guests are sent to sign-in, users who have not accepted
 * the current consent text see only the consent screen. The API enforces both (403
 * CONSENT_REQUIRED); this is the matching UX.
 */
export function ConsentGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe();
  const guest = me.isSuccess && me.data === null;

  useEffect(() => {
    if (guest) router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
  }, [guest, pathname, router]);

  if (me.isPending) return <p role="status">{t('auth.session.loading')}</p>;
  if (me.isError) {
    return (
      <div role="alert" className="alert alert-error">
        <p>{t('auth.session.loadFailed')}</p>
        <button type="button" className="button button-secondary" onClick={() => void me.refetch()}>
          {t('auth.session.retry')}
        </button>
      </div>
    );
  }
  if (!me.data) return <p role="status">{t('auth.session.redirecting')}</p>;
  if (me.data.consentRequired) return <ConsentScreen />;
  return <>{children}</>;
}
