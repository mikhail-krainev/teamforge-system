const TOKEN_MIN = 16;
const TOKEN_MAX = 256;
const TOKEN_CHARS = /^[A-Za-z0-9._~-]+$/;

/**
 * Reads `token` from a URL fragment such as `#token=abc`. The magic-link token lives in the
 * fragment so it never reaches server logs or the Referer header (SEC-09). Returns `null` when the
 * fragment has no token or it does not look like one (length and charset follow the contract).
 */
export function readTokenFromFragment(hash: string): string | null {
  if (hash.startsWith('?')) return null;
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const token = params.get('token');
  if (token === null) return null;
  if (token.length < TOKEN_MIN || token.length > TOKEN_MAX) return null;
  return TOKEN_CHARS.test(token) ? token : null;
}

const SAFE_PATH = /^\/(?![/\\])[A-Za-z0-9/_\-?=&.%]*$/;
const PATH_MAX = 512;

/** A same-app relative path or `fallback`: blocks absolute URLs, `//host` and `javascript:` (SEC-08). */
export function safeRedirectPath(value: string | null | undefined, fallback = '/profile'): string {
  if (!value || value.length > PATH_MAX || !SAFE_PATH.test(value)) return fallback;
  return value;
}

/** Drops the fragment from the address bar without adding a history entry. */
export function stripFragment(win: Pick<Window, 'location' | 'history'> = window): void {
  const { pathname, search } = win.location;
  win.history.replaceState(null, '', `${pathname}${search}`);
}
