import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { describeInfra } from '../helpers/infra.js';

const WEB = '10.20.0.2';
const CADDY = '10.20.0.3';
const publicIp = (): string => `203.0.${randomInt(0, 256)}.${randomInt(1, 255)}`;

// S2SEC-03 (architecture 13.6): Caddy -> web -> api. TRUSTED_PROXY_CIDRS lists web and Caddy; the
// client is the first address from the right that is not a trusted proxy. The limit key is its hash.
describeInfra(
  'S2SEC-03: rate-limit keys follow the real client behind trusted proxies',
  ['redis'],
  () => {
    let testApp: TestApp;

    beforeAll(async () => {
      testApp = await createTestApp({ env: { TRUSTED_PROXY_CIDRS: `${WEB}/32,${CADDY}/32` } });
    });

    afterAll(async () => {
      await testApp.close();
    });

    const hit = (remoteAddress: string, forwarded: string) =>
      testApp.app.inject({
        method: 'GET',
        url: '/api/v1/_test/limited', // 3 hits per minute per client IP
        headers: { 'x-test-user': 'u', 'x-forwarded-for': forwarded },
        remoteAddress,
      });

    const exhaust = async (remoteAddress: string, forwarded: () => string) => {
      for (let i = 0; i < 3; i += 1)
        expect((await hit(remoteAddress, forwarded())).statusCode).toBe(200);
      expect((await hit(remoteAddress, forwarded())).statusCode).toBe(429);
    };

    it('two clients behind the same trusted web are counted separately', async () => {
      const [a, b] = [publicIp(), publicIp()];
      await exhaust(WEB, () => a);
      expect((await hit(WEB, b)).statusCode).toBe(200);
    });

    it('web forwards the chain from Caddy ("client, caddy"): the client is the key, not Caddy', async () => {
      const [a, b] = [publicIp(), publicIp()];
      await exhaust(WEB, () => `${a}, ${CADDY}`);
      expect((await hit(WEB, `${b}, ${CADDY}`)).statusCode).toBe(200);
    });

    it('addresses a client prepends to X-Forwarded-For do not change its key', async () => {
      const a = publicIp();
      await exhaust(WEB, () => `${publicIp()}, ${a}, ${CADDY}`);
    });

    it('X-Forwarded-For from an untrusted source is ignored: the socket address is the key', async () => {
      const remote = publicIp();
      await exhaust(remote, publicIp);
    });
  },
);
