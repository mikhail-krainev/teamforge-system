export type Theme = 'light' | 'dark';

/** Cookie with the forced theme; absent means "follow the system". */
export const THEME_COOKIE = 'theme';

/** Parses the cookie value; anything unknown means "follow the system". */
export function parseTheme(value: string | undefined): Theme | undefined {
  return value === 'light' || value === 'dark' ? value : undefined;
}
