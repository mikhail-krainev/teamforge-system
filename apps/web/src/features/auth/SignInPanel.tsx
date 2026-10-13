'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { t } from '@/i18n';
import { GithubButton } from './GithubButton';
import { MagicLinkForm } from './MagicLinkForm';
import { useMe } from './session';

export function SignInPanel({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const me = useMe();
  const signedIn = Boolean(me.data);

  useEffect(() => {
    if (signedIn) router.replace(nextPath);
  }, [signedIn, nextPath, router]);

  if (signedIn) {
    return (
      <p role="status" className="muted">
        {t('auth.signIn.alreadySignedIn')}
      </p>
    );
  }
  return (
    <div className="stack">
      <GithubButton callbackPath={nextPath} />
      <p className="divider" aria-hidden="true">
        {t('auth.signIn.or')}
      </p>
      <MagicLinkForm callbackPath={nextPath} />
    </div>
  );
}
