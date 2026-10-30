import Link from 'next/link';
import { Yeti } from '@/components/mascot/Yeti';
import { t } from '@/i18n';

const FOOTER_LINKS = [
  { href: '/teams', labelKey: 'teams.nav.teams' },
  { href: '/demand', labelKey: 'matching.nav.demand' },
  { href: '/reviews', labelKey: 'reviews.nav' },
] as const;

/** Site footer: the sleeping Yeti, one honest line, and shortcuts to public sections. */
export function Footer() {
  return (
    <footer className="footer container">
      <div className="footer-inner">
        <div className="footer-brand">
          <Yeti pose="sleep" size={72} />
          <p className="muted footer-tagline">{t('shell.footer.tagline')}</p>
        </div>
        <nav className="footer-nav" aria-label={t('shell.footer.navLabel')}>
          {FOOTER_LINKS.map((link) => (
            <Link key={link.href} href={link.href}>
              {t(link.labelKey)}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
