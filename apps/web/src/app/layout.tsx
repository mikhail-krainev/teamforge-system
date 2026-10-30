import type { Metadata, Viewport } from 'next';
import {
  Bricolage_Grotesque,
  Caveat,
  Chakra_Petch,
  Fredoka,
  Martian_Mono,
  Noto_Serif_Display,
  Onest,
  Space_Grotesk,
  Special_Elite,
  Syne,
} from 'next/font/google';
import { cookies } from 'next/headers';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { parseTheme, THEME_COOKIE } from '@/components/shell/theme';
import { t } from '@/i18n';
import { Providers } from './providers';
import './globals.css';
import './forms.css';
import './decor.css';
import './route.css';
import './feedback.css';
import './motion.css';

// Self-hosted at build time by next/font: the CSP allows fonts from 'self' only.
const sans = Onest({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600'],
  variable: '--font-sans-loaded',
  display: 'swap',
});
const serif = Noto_Serif_Display({
  subsets: ['latin', 'cyrillic'],
  weight: ['200', '300'],
  style: ['normal', 'italic'],
  variable: '--font-serif-loaded',
  display: 'swap',
});
const mono = Martian_Mono({
  subsets: ['latin', 'cyrillic'],
  // Variable font: weight and the wdth axis are both served from one file.
  axes: ['wdth'],
  variable: '--font-mono-loaded',
  display: 'swap',
});

// Handwriting of the notes on the landing work board.
const hand = Caveat({
  subsets: ['latin', 'cyrillic'],
  weight: ['600', '700'],
  variable: '--font-hand',
  display: 'swap',
});

// Display fonts of the role marquee on the landing page, one per direction (latin only).
const roleFrontend = Syne({
  subsets: ['latin'],
  weight: ['700'],
  variable: '--font-role-frontend',
  display: 'swap',
});
const roleQa = Special_Elite({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-role-qa',
  display: 'swap',
});
const roleAnalytics = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '700'],
  variable: '--font-role-analytics',
  display: 'swap',
});
const roleMobile = Fredoka({
  subsets: ['latin'],
  weight: ['500', '600'],
  variable: '--font-role-mobile',
  display: 'swap',
});
const roleDevops = Chakra_Petch({
  subsets: ['latin'],
  weight: ['600'],
  variable: '--font-role-devops',
  display: 'swap',
});
const roleProduct = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['700'],
  variable: '--font-role-product',
  display: 'swap',
});
const roleFonts = [roleFrontend, roleQa, roleAnalytics, roleMobile, roleDevops, roleProduct]
  .map((font) => font.variable)
  .join(' ');

export const metadata: Metadata = {
  title: t('shell.title'),
  description: t('shell.description'),
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f1e7' },
    { media: '(prefers-color-scheme: dark)', color: '#12100d' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page is rendered per request: the CSP nonce (src/proxy.ts) can only be applied to
  // server-rendered HTML, never to a prerendered page (architecture 13.10).
  await connection();
  // A forced theme from ThemeToggle is rendered on <html> so the first paint is already right.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html
      lang="ru"
      data-theme={theme}
      className={`${sans.variable} ${serif.variable} ${mono.variable} ${hand.variable} ${roleFonts}`}
    >
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
