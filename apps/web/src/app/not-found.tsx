import Link from 'next/link';
import { t } from '@/i18n';

export default function NotFound() {
  return (
    <section className="card not-found">
      <h1>{t('notFound.heading')}</h1>
      <p>{t('notFound.text')}</p>
      <Link href="/" className="button">
        {t('notFound.home')}
      </Link>
    </section>
  );
}
