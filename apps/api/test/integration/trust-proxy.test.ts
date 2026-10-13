import { afterAll, beforeAll, expect, it, describe } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app.js';

// No database or Redis is touched: the app is created with unreachable dependencies.
describe('S1-07 trustProxy (SEC-16): X-Forwarded-For is honoured only from listed proxies', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ env: { TRUSTED_PROXY_CIDRS: '10.20.0.0/16' } });
  });

  afterAll(async () => {
    await testApp.close();
  });

  const ipSeenBy = async (remoteAddress: string, forwarded?: string): Promise<string> => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/_test/ip',
      headers: { 'x-test-user': 'u', ...(forwarded ? { 'x-forwarded-for': forwarded } : {}) },
      remoteAddress,
    });
    return response.json<{ ip: string }>().ip;
  };

  it('ignores a spoofed X-Forwarded-For from an untrusted client', async () => {
    expect(await ipSeenBy('198.51.100.5', '1.2.3.4')).toBe('198.51.100.5');
  });

  it('uses X-Forwarded-For from a trusted proxy address', async () => {
    expect(await ipSeenBy('10.20.1.1', '203.0.113.9')).toBe('203.0.113.9');
  });

  it('gives different clients behind the same proxy different keys', async () => {
    const first = await ipSeenBy('10.20.1.1', '203.0.113.9');
    const second = await ipSeenBy('10.20.1.1', '203.0.113.10');
    expect(first).not.toBe(second);
  });

  it('S2SEC-03: behind Caddy and web the client is the first untrusted address from the right', async () => {
    // remote = web (10.20.0.2); X-Forwarded-For = "client, caddy"; both proxies are trusted.
    expect(await ipSeenBy('10.20.0.2', '203.0.113.9, 10.20.0.3')).toBe('203.0.113.9');
    // addresses prepended by the client sit to the left of the real one and are ignored
    expect(await ipSeenBy('10.20.0.2', '6.6.6.6, 203.0.113.9, 10.20.0.3')).toBe('203.0.113.9');
    // web did not append anything: the last entry is the client itself
    expect(await ipSeenBy('10.20.0.2', '203.0.113.9')).toBe('203.0.113.9');
  });

  it('S2SEC-03: an untrusted peer cannot inject a chain, whatever the header says', async () => {
    expect(await ipSeenBy('198.51.100.5', '203.0.113.9, 10.20.0.3')).toBe('198.51.100.5');
  });
});
