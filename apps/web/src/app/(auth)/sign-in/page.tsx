import { safeRedirectPath } from '@/features/auth/fragment';
import { signInErrorMessage } from '@/features/auth/sign-in-error';
import { SignInPanel } from '@/features/auth/SignInPanel';
import { Yeti } from '@/components/mascot/Yeti';
import { Alert } from '@/components/ui/Alert';
import { t } from '@/i18n';
import '@/features/auth/auth.css';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
}) {
  const { next, error } = await searchParams;
  const nextPath = safeRedirectPath(typeof next === 'string' ? next : undefined);
  const errorMessage = signInErrorMessage(typeof error === 'string' ? error : undefined);
  return (
    <div className="sign-in">
      <section className="block block-blue sign-in-hero">
        <h1 className="display">
          {t('auth.signIn.heroBefore')} <span className="serif">{t('auth.signIn.heroSerif')}</span>{' '}
          {t('auth.signIn.heroAfter')}
        </h1>
        <div className="sign-in-hero-foot">
          <p>{t('auth.signIn.heroNote')}</p>
          <Yeti pose="wave" size={152} />
        </div>
      </section>
      <section className="sign-in-form" aria-labelledby="sign-in-heading">
        <p className="section-mark">{t('auth.signIn.formMark')}</p>
        <h2 id="sign-in-heading">{t('auth.signIn.formTitle')}</h2>
        <p className="muted">{t('auth.signIn.lead')}</p>
        {errorMessage ? <Alert tone="error">{errorMessage}</Alert> : null}
        <SignInPanel nextPath={nextPath} />
      </section>
    </div>
  );
}
