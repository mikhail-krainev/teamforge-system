import { safeRedirectPath } from '@/features/auth/fragment';
import { SignInPanel } from '@/features/auth/SignInPanel';
import { t } from '@/i18n';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const nextPath = safeRedirectPath(typeof next === 'string' ? next : undefined);
  return (
    <div className="page-narrow">
      <h1>{t('auth.signIn.title')}</h1>
      <p className="lead">{t('auth.signIn.lead')}</p>
      <div className="card">
        <SignInPanel nextPath={nextPath} />
      </div>
    </div>
  );
}
