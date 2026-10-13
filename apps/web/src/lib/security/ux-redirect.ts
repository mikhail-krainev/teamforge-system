/**
 * UX-only redirects for the proxy (NOT access control: the API checks every right, SEC-14).
 * A missing session cookie sends a guest straight to sign-in. A forged or stale cookie only changes
 * which page is shown first, because `getMe` still decides on the client (see ConsentGate).
 */
const SESSION_COOKIES = ['better-auth.session_token', '__Secure-better-auth.session_token'];
const PROTECTED_PREFIXES = ['/profile', '/settings', '/users'];

export function hasSessionCookie(has: (name: string) => boolean): boolean {
  return SESSION_COOKIES.some(has);
}

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export interface RedirectDecision {
  pathname: string;
  search: string;
}

/** Target of a UX redirect, or `null` to continue normally. */
export function decideUxRedirect(
  pathname: string,
  search: string,
  signedInCookie: boolean,
): RedirectDecision | null {
  if (!signedInCookie && isProtected(pathname)) {
    return { pathname: '/sign-in', search: `?next=${encodeURIComponent(pathname + search)}` };
  }
  return null;
}
