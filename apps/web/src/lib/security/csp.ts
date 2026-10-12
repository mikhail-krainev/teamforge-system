/**
 * Content-Security-Policy of the web application (architecture 13.10, S1R-09).
 *
 * Scripts: `'self'` plus a per-request nonce and `'strict-dynamic'`; there is NO `'unsafe-inline'`
 * for scripts. Next.js puts the nonce on its framework scripts when the page is rendered
 * dynamically with this header present (`src/proxy.ts` sets it, the root layout opts in with
 * `connection()`).
 *
 * Styles: `'self'` plus the nonce for `<style>` elements; style ATTRIBUTES need `'unsafe-inline'`
 * (`style-src-attr`), which cannot execute script. Documented, not hidden: if the attribute use
 * disappears, drop `style-src-attr`.
 *
 * `upgrade-insecure-requests` is deliberately absent: the development stack runs on plain
 * http://localhost; HTTPS is enforced by Caddy and HSTS in production (phase 7).
 */
export interface CspOptions {
  /** Development needs `'unsafe-eval'` for React's debugging aids; production never does. */
  development?: boolean;
}

export function buildCsp(nonce: string, { development = false }: CspOptions = {}): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  return directives.join('; ');
}

/** 128 bits from the Web Crypto API, base64: unguessable and unique per request. */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
