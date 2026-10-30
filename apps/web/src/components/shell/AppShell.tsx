import Link from 'next/link';
import type { ReactNode } from 'react';
import { YetiLife } from '@/components/mascot/life/YetiLife';
import { YetiMark } from '@/components/mascot/YetiMark';
import { AccountMenu } from '@/features/auth/AccountMenu';
import { NotificationBell } from '@/features/notifications/NotificationBell';
import { t } from '@/i18n';
import { Footer } from './Footer';
import { collectNavItems } from './nav';
import { ShellNav } from './ShellNav';
import { ThemeToggle } from './ThemeToggle';
import './shell.css';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main">
        {t('shell.skipLink')}
      </a>
      <header className="shell-header">
        <div className="container shell-header-inner">
          <Link href="/" className="brand" aria-label={t('shell.homeLink')}>
            <YetiMark size={36} />
            <span className="brand-text">{t('shell.appName')}</span>
          </Link>
          <div className="shell-actions">
            <ThemeToggle />
            <NotificationBell />
            <AccountMenu />
          </div>
          <ShellNav items={collectNavItems()} />
        </div>
      </header>
      <main id="main" tabIndex={-1} className="sheet shell-main">
        <div className="container shell-content">{children}</div>
        <Footer />
      </main>
      {/* Толик lives on every page; the shell stays mounted, so he keeps going across navigation. */}
      <YetiLife />
    </>
  );
}
