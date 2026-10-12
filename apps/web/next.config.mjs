// Security-relevant settings follow docs/architecture.md section 13.10.
const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/**
 * Headers for every page (not for /api: the API sets its own). The Content-Security-Policy with a
 * per-request nonce cannot be static; it is added by src/proxy.ts.
 */
export const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  transpilePackages: ['shared'],
  // The image optimizer must never fetch external addresses.
  images: { unoptimized: true, remotePatterns: [] },
  // Server Actions are not used, so `experimental.serverActions` stays unset.
  async headers() {
    return [{ source: '/((?!api/).*)', headers: securityHeaders }];
  },
  async rewrites() {
    // One origin: the browser talks to /api, Next proxies it to the API container.
    // Note: rewrites are resolved at build time, so API_INTERNAL_URL is a build argument.
    return [{ source: '/api/:path*', destination: `${apiInternalUrl}/api/:path*` }];
  },
};

export default nextConfig;
