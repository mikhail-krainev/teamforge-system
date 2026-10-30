import Link from 'next/link';
import { Yeti } from '@/components/mascot/Yeti';
import { t } from '@/i18n';
import './not-found.css';

export default function NotFound() {
  return (
    <section className="not-found-screen">
      <div className="not-found-figure">
        <Yeti pose="sad" size={200} />
        <span className="sticker sticker-yellow not-found-sticker" aria-hidden="true">
          {t('notFound.notFoundMark')}
        </span>
      </div>
      <h1 className="display">
        {t('notFound.before')} <span className="serif-i">{t('notFound.serif')}</span>
      </h1>
      <p className="muted">{t('notFound.line')}</p>
      <Link href="/" className="cta-pair">
        <span className="button">{t('notFound.home')}</span>
        <span className="arrow" aria-hidden="true">
          →
        </span>
      </Link>
    </section>
  );
}
