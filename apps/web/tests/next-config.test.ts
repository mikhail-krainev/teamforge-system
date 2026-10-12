import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config.mjs';

const require = createRequire(import.meta.url);

function parse(version: string): number[] {
  return version.split('-')[0]!.split('.').map(Number);
}

describe('Next.js security settings (architecture 13.10)', () => {
  it('disables the image optimizer and remote patterns', () => {
    expect(nextConfig.images).toEqual({ unoptimized: true, remotePatterns: [] });
  });

  it('does not enable Server Actions', () => {
    expect(nextConfig.experimental?.serverActions).toBeUndefined();
  });

  it('proxies /api/* through rewrites', async () => {
    const rewrites = await nextConfig.rewrites?.();
    expect(rewrites).toEqual([
      { source: '/api/:path*', destination: expect.stringMatching(/\/api\/:path\*$/) },
    ]);
  });

  it('uses a Next.js version with the CVE-2025-29927 fix (>= 15.2.3)', () => {
    const { version } = require('next/package.json') as { version: string };
    const [major = 0, minor = 0, patch = 0] = parse(version);
    const ok = major > 15 || (major === 15 && (minor > 2 || (minor === 2 && patch >= 3)));
    expect(ok).toBe(true);
  });
});
