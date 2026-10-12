import Link from 'next/link';
import type { ReactNode } from 'react';
import { t } from '@/i18n';
import { collectNavItems } from './nav';
import { ShellNav } from './ShellNav';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main">
        {t('shell.skipLink')}
      </a>
      <header className="shell-header">
        <div className="container shell-header-inner">
          <Link href="/" className="brand" aria-label={t('shell.homeLink')}>
            {t('shell.appName')}
          </Link>
          <ShellNav items={collectNavItems()} />
        </div>
      </header>
      <main id="main" tabIndex={-1} className="container shell-main">
        {children}
      </main>
    </>
  );
}
