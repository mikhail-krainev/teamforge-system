import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { t } from '@/i18n';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: t('shell.title'),
  description: t('shell.description'),
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f0fdfa' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1514' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page is rendered per request: the CSP nonce (src/proxy.ts) can only be applied to
  // server-rendered HTML, never to a prerendered page (architecture 13.10).
  await connection();
  return (
    <html lang="ru">
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
