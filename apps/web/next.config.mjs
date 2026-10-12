// Security-relevant settings follow docs/architecture.md section 13.10.
const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  transpilePackages: ['shared'],
  // The image optimizer must never fetch external addresses.
  images: { unoptimized: true, remotePatterns: [] },
  // Server Actions are not used, so `experimental.serverActions` stays unset.
  async rewrites() {
    // One origin: the browser talks to /api, Next proxies it to the API container.
    // Note: rewrites are resolved at build time, so API_INTERNAL_URL is a build argument.
    return [{ source: '/api/:path*', destination: `${apiInternalUrl}/api/:path*` }];
  },
};

export default nextConfig;
