import { type NextRequest, NextResponse } from 'next/server';
import { buildCsp, generateNonce } from '@/lib/security/csp';

/**
 * Next.js 16 `proxy` (formerly middleware): attaches the nonce-based CSP to every page request.
 * It is NOT an access check (rights are checked only by the API, architecture 13.10 / SEC-14).
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = generateNonce();
  const csp = buildCsp(nonce, { development: process.env.NODE_ENV === 'development' });
  const requestHeaders = new Headers(request.headers);
  // Next.js reads the nonce from the request's CSP header while rendering.
  requestHeaders.set('Content-Security-Policy', csp);
  requestHeaders.set('x-nonce', nonce);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not the API (it sets its own headers), static assets or prefetches.
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
