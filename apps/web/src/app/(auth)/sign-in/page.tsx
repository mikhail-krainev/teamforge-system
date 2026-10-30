import { safeRedirectPath } from '@/features/auth/fragment';
import { signInErrorMessage } from '@/features/auth/sign-in-error';
import { SignInPanel } from '@/features/auth/SignInPanel';
import { Alert } from '@/components/ui/Alert';
import { t } from '@/i18n';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
}) {
  const { next, error } = await searchParams;
  const nextPath = safeRedirectPath(typeof next === 'string' ? next : undefined);
  const errorMessage = signInErrorMessage(typeof error === 'string' ? error : undefined);
  return (
    <div className="page-narrow">
      <h1>{t('auth.signIn.title')}</h1>
      <p className="lead">{t('auth.signIn.lead')}</p>
      {errorMessage ? <Alert tone="error">{errorMessage}</Alert> : null}
      <div className="card">
        <SignInPanel nextPath={nextPath} />
      </div>
    </div>
  );
}
