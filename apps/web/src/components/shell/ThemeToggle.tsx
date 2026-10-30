'use client';

import { t } from '@/i18n';
import { THEME_COOKIE, type Theme } from './theme';

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Theme in effect now: the forced one from html[data-theme], else the system preference. */
function currentTheme(): Theme {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'light' || forced === 'dark') return forced;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Pixel sun and moon; CSS shows the one for the theme you switch to, so SSR needs no theme. */
function ThemeIcons() {
  return (
    <svg
      className="theme-icons"
      width="20"
      height="20"
      viewBox="0 0 10 10"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <g className="theme-icon-moon">
        <path fill="currentColor" d="M3 1h3v1H4v1H3v4h1v1h2v1H3V8H2V7H1V3h1V2h1z" />
        <path fill="currentColor" d="M6 8h2v1H6zM8 7h1v1H8z" />
      </g>
      <g className="theme-icon-sun">
        <path fill="currentColor" d="M3 3h4v4H3z" />
        <path fill="currentColor" d="M4.5 0h1v2h-1zM4.5 8h1v2h-1zM0 4.5h2v1H0zM8 4.5h2v1H8z" />
        <path fill="currentColor" d="M1 1h1v1H1zM8 1h1v1H8zM1 8h1v1H1zM8 8h1v1H8z" />
      </g>
    </svg>
  );
}

/** Header button: flips light and dark and remembers the choice in a cookie read by the layout. */
export function ThemeToggle() {
  const onClick = () => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    const secure = window.location.protocol === 'https:' ? '; secure' : '';
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax${secure}`;
  };
  return (
    <button
      type="button"
      className="icon-button theme-toggle"
      aria-label={t('shell.themeToggle')}
      title={t('shell.themeToggle')}
      onClick={onClick}
    >
      <ThemeIcons />
    </button>
  );
}
