import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import nextConfig, { securityHeaders } from '../next.config.mjs';
import { proxy, config as proxyConfig } from '../src/proxy';
import { buildCsp, generateNonce } from '../src/lib/security/csp';

function directive(csp: string, name: string): string {
  return csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';
}

describe('Content-Security-Policy (S1R-09, architecture 13.10)', () => {
  const csp = buildCsp('NONCE123');

  it('allows scripts only from self with the request nonce, never inline', () => {
    const script = directive(csp, 'script-src');
    expect(script).toBe("script-src 'self' 'nonce-NONCE123' 'strict-dynamic'");
    expect(script).not.toContain('unsafe-inline');
    expect(script).not.toContain('unsafe-eval');
  });

  it('forbids framing, plugins, foreign bases and foreign form targets', () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
  });

  it('keeps unsafe-inline out of style elements (only style attributes may use it)', () => {
    expect(directive(csp, 'style-src')).toBe("style-src 'self' 'nonce-NONCE123'");
    expect(directive(csp, 'style-src-attr')).toBe("style-src-attr 'unsafe-inline'");
  });

  it('allows unsafe-eval in development only', () => {
    expect(directive(buildCsp('n', { development: true }), 'script-src')).toContain(
      "'unsafe-eval'",
    );
  });

  it('generates a fresh unguessable nonce per call', () => {
    const nonces = new Set(Array.from({ length: 50 }, generateNonce));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe('proxy.ts', () => {
  it('sets the CSP with a nonce on every page response and passes it to the renderer', () => {
    const response = proxy(new NextRequest('http://localhost:3000/'));
    const header = response.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(header)?.[1];
    expect(nonce).toBeTruthy();
    expect(header).toBe(buildCsp(nonce ?? ''));
    // NextResponse.next({ request }) exposes the rewritten request headers to the renderer.
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(header);
    expect(response.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
  });

  it('uses a different nonce for every request', () => {
    const nonceOf = (): string | undefined =>
      /'nonce-([^']+)'/.exec(
        proxy(new NextRequest('http://localhost:3000/')).headers.get('content-security-policy') ??
          '',
      )?.[1];
    expect(nonceOf()).not.toBe(nonceOf());
  });

  it('does not cover /api, static assets or prefetches', () => {
    const [matcher] = proxyConfig.matcher;
    expect(matcher?.source).toContain('(?!api|_next/static|_next/image');
    expect(matcher?.missing).toContainEqual({ type: 'header', key: 'next-router-prefetch' });
  });
});

describe('static security headers in next.config.mjs', () => {
  const byKey = Object.fromEntries(securityHeaders.map((h) => [h.key, h.value]));

  it('sets nosniff, no framing, referrer and permissions policies, COOP and HSTS', () => {
    expect(byKey['X-Content-Type-Options']).toBe('nosniff');
    expect(byKey['X-Frame-Options']).toBe('DENY');
    expect(byKey['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(byKey['Permissions-Policy']).toContain('camera=()');
    expect(byKey['Permissions-Policy']).toContain('geolocation=()');
    expect(byKey['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(byKey['Strict-Transport-Security']).toMatch(/^max-age=\d{7,}/);
  });

  it('applies them to pages but not to the proxied API', async () => {
    const rules = await nextConfig.headers?.();
    expect(rules).toEqual([{ source: '/((?!api/).*)', headers: securityHeaders }]);
    const source = new RegExp(`^${rules?.[0]?.source}$`);
    expect(source.test('/')).toBe(true);
    expect(source.test('/teams/1')).toBe(true);
    expect(source.test('/api/health/ready')).toBe(false);
  });
});
