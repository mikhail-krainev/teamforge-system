import { describe, expect, it } from 'vitest';
import { isForbiddenAddress } from './ip-policy.js';
import { createLinkChecker, DomainBusy, type Hop, type HopResponse } from './ssrf-client.js';

/*
 * S5-14: edges of the SSRF client that the scenarios of slice 5 do not reach: what a failing resolver or
 * request may throw, an answer without addresses, a public address written as the host, redirects whose
 * target cannot be parsed or loops back, and the zone and dotted spellings of IPv6 addresses.
 */

const PUBLIC_IP = '93.184.216.34';

interface Setup {
  resolve?: (hostname: string) => Promise<string[]>;
  responses?: (HopResponse | (() => Promise<HopResponse>))[];
  timeoutMs?: number;
  totalTimeoutMs?: number;
}

function checker(setup: Setup = {}) {
  const hops: Hop[] = [];
  const lookups: string[] = [];
  const queue = [...(setup.responses ?? [{ status: 200 }])];
  const client = createLinkChecker({
    resolve: (hostname) => {
      lookups.push(hostname);
      return (setup.resolve ?? (() => Promise.resolve([PUBLIC_IP])))(hostname);
    },
    request: (hop) => {
      hops.push(hop);
      const next = queue.shift() ?? { status: 200 };
      return typeof next === 'function' ? next() : Promise.resolve(next);
    },
    ...(setup.timeoutMs === undefined ? {} : { timeoutMs: setup.timeoutMs }),
    ...(setup.totalTimeoutMs === undefined ? {} : { totalTimeoutMs: setup.totalTimeoutMs }),
  });
  return { hops, lookups, check: client.check };
}

describe('S5-14: the resolver and the request fail in unusual ways', () => {
  it('a resolver that never answers -> TIMEOUT (not DNS_ERROR), and no request is made', async () => {
    const c = checker({ resolve: () => new Promise(() => undefined), timeoutMs: 30 });
    expect(await c.check('https://slow-dns.example.test/')).toEqual({
      ok: false,
      reason: 'TIMEOUT',
      httpStatus: null,
    });
    expect(c.hops).toEqual([]);
  });

  it('an empty answer of the resolver -> DNS_ERROR, no request', async () => {
    const c = checker({ resolve: () => Promise.resolve([]) });
    expect(await c.check('https://empty.example.test/')).toMatchObject({
      ok: false,
      reason: 'DNS_ERROR',
    });
    expect(c.hops).toEqual([]);
  });

  it('a resolver that throws something that is not an Error -> DNS_ERROR', async () => {
    const c = checker({ resolve: () => Promise.reject('boom') });
    expect(await c.check('https://odd.example.test/')).toMatchObject({ reason: 'DNS_ERROR' });
  });

  it.each([
    ['a string', 'connection reset'],
    ['null', null],
    ['a number', 42],
  ])(
    'a request that throws %s is "no answer": TIMEOUT, nothing of it is passed on',
    async (_, thrown) => {
      const c = checker({ responses: [() => Promise.reject(thrown)] });
      const result = await c.check('https://example.test/');
      expect(result).toEqual({ ok: false, reason: 'TIMEOUT', httpStatus: null });
    },
  );

  it.each([
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'EPROTO',
  ])('a request that fails with %s -> TLS_ERROR', async (code) => {
    const c = checker({
      responses: [() => Promise.reject(Object.assign(new Error('x'), { code }))],
    });
    expect(await c.check('https://example.test/')).toMatchObject({ reason: 'TLS_ERROR' });
  });

  it('an error code that is not about TLS (ECONNRESET) and an error without a code are both TIMEOUT', async () => {
    const reset = checker({
      responses: [() => Promise.reject(Object.assign(new Error('x'), { code: 'ECONNRESET' }))],
    });
    expect(await reset.check('https://example.test/')).toMatchObject({ reason: 'TIMEOUT' });
    const plain = checker({ responses: [() => Promise.reject(new Error('x'))] });
    expect(await plain.check('https://example.test/')).toMatchObject({ reason: 'TIMEOUT' });
  });
});

describe('S5-14: the host as it is written', () => {
  it('a public IP literal is requested directly, without a lookup, with the literal as SNI and Host', async () => {
    const c = checker();
    expect(await c.check(`https://${PUBLIC_IP}/page?q=1`)).toMatchObject({ ok: true });
    expect(c.lookups).toEqual([]);
    expect(c.hops).toHaveLength(1);
    expect(c.hops[0]).toMatchObject({
      ip: PUBLIC_IP,
      port: 443,
      servername: PUBLIC_IP,
      host: PUBLIC_IP,
      path: '/page?q=1',
    });
  });

  it('a host that is only a dot is nothing to connect to -> BLOCKED_ADDRESS, no lookup, no request', async () => {
    const c = checker();
    expect(await c.check('https://./')).toMatchObject({ ok: false, reason: 'BLOCKED_ADDRESS' });
    expect(c.lookups).toEqual([]);
    expect(c.hops).toEqual([]);
  });

  it('a string that is not a URL at all -> BLOCKED_ADDRESS (the check is closed, not open)', async () => {
    const c = checker();
    expect(await c.check('not a url')).toMatchObject({ ok: false, reason: 'BLOCKED_ADDRESS' });
    expect(c.hops).toEqual([]);
  });

  it('a trailing dot of the name is dropped for the lookup, and SNI is the name without it', async () => {
    const c = checker();
    expect(await c.check('https://example.test./')).toMatchObject({ ok: true });
    expect(c.lookups).toEqual(['example.test']);
    expect(c.hops[0]?.servername).toBe('example.test');
  });
});

describe('S5-14: redirects', () => {
  it('a redirect to an address that cannot be parsed ends as BLOCKED_ADDRESS, not as a crash', async () => {
    const c = checker({ responses: [{ status: 302, location: 'https://' }] });
    expect(await c.check('https://example.test/')).toMatchObject({
      ok: false,
      reason: 'BLOCKED_ADDRESS',
    });
    expect(c.hops).toHaveLength(1);
  });

  it('a redirect to http: is BLOCKED_PORT and is never requested', async () => {
    const c = checker({ responses: [{ status: 301, location: 'http://example.test/plain' }] });
    expect(await c.check('https://example.test/')).toMatchObject({ reason: 'BLOCKED_PORT' });
    expect(c.hops).toHaveLength(1);
  });

  it('a redirect to the very page that was asked for is a loop at once, not three more requests', async () => {
    const c = checker({
      responses: [
        { status: 302, location: '/same' },
        { status: 302, location: '/same' },
      ],
    });
    expect(await c.check('https://example.test/same')).toMatchObject({
      ok: false,
      reason: 'TOO_MANY_REDIRECTS',
    });
    expect(c.hops).toHaveLength(1);
  });

  it('a 3xx without a Location is a plain HTTP_STATUS answer (nowhere to go)', async () => {
    const c = checker({ responses: [{ status: 302 }] });
    expect(await c.check('https://example.test/')).toEqual({
      ok: false,
      reason: 'HTTP_STATUS',
      httpStatus: 302,
    });
  });

  it('300 and 304 are not followed even with a Location; 3xx that are followed are exactly 301, 302, 303, 307, 308', async () => {
    for (const status of [300, 304, 305, 306]) {
      const c = checker({ responses: [{ status, location: 'https://example.test/next' }] });
      expect(await c.check('https://example.test/')).toEqual({
        ok: false,
        reason: 'HTTP_STATUS',
        httpStatus: status,
      });
      expect(c.hops).toHaveLength(1);
    }
    for (const status of [301, 302, 303, 307, 308]) {
      const c = checker({
        responses: [{ status, location: 'https://example.test/next' }, { status: 200 }],
      });
      expect(await c.check('https://example.test/')).toMatchObject({ ok: true });
      expect(c.hops.map((h) => h.path)).toEqual(['/', '/next']);
    }
  });

  it('every hop resolves the name again and a hop to another name is judged on its own addresses', async () => {
    const c = checker({
      resolve: (hostname) =>
        Promise.resolve(hostname === 'inner.example.test' ? ['10.0.0.9'] : [PUBLIC_IP]),
      responses: [{ status: 302, location: 'https://inner.example.test/' }],
    });
    expect(await c.check('https://example.test/')).toMatchObject({ reason: 'BLOCKED_ADDRESS' });
    expect(c.lookups).toEqual(['example.test', 'inner.example.test']);
    expect(c.hops).toHaveLength(1);
  });

  it('an answer of 2xx is ok for the whole 200..299 range and nothing else', async () => {
    for (const status of [200, 204, 299]) {
      expect(await checker({ responses: [{ status }] }).check('https://example.test/')).toEqual({
        ok: true,
        reason: null,
        httpStatus: status,
      });
    }
    for (const status of [199, 400, 404, 500, 503]) {
      expect(await checker({ responses: [{ status }] }).check('https://example.test/')).toEqual({
        ok: false,
        reason: 'HTTP_STATUS',
        httpStatus: status,
      });
    }
  });
});

describe('S5-14: IPv6 spellings of forbidden addresses', () => {
  it.each([
    'fe80::1%eth0',
    'fe80::1%25eth0',
    '::1.2.3.4',
    '::127.0.0.1',
    '64:ff9b::10.0.0.1',
    '2001:db8::10.0.0.1',
    '0:0:0:0:0:ffff:7f00:1',
    '0000:0000:0000:0000:0000:ffff:127.0.0.1',
    'FE80::1',
    '::FFFF:A00:1',
  ])('%s is forbidden', (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each(['2606:2800:220:1::1', '::ffff:93.184.216.34', '2a00:1450::1%eth0'])(
    '%s is a public address and stays allowed',
    (address) => {
      expect(isForbiddenAddress(address)).toBe(false);
    },
  );
});

describe('S5 audit L1/L2: the throttle of every hop and one deadline for the whole check', () => {
  const redirect = (location: string): HopResponse => ({ status: 302, location });

  it('a redirect to a domain that is busy stops the check with DomainBusy and no request goes there', async () => {
    const c = checker({ responses: [redirect('https://Busy.Example.test./next')] });
    const asked: string[] = [];
    const throttle = (hostname: string) => {
      asked.push(hostname);
      return Promise.resolve(hostname === 'busy.example.test' ? 4_000 : 0);
    };
    await expect(c.check('https://first.example.test/', { throttle })).rejects.toEqual(
      new DomainBusy(4_000),
    );
    // The first hop is the worker's business; every later hop is asked, in one spelling.
    expect(asked).toEqual(['busy.example.test']);
    expect(c.hops.map((h) => h.servername)).toEqual(['first.example.test']);
  });

  it('every redirect hop asks the throttle once; free domains pass', async () => {
    const c = checker({
      responses: [
        redirect('https://b.example.test/'),
        redirect('https://c.example.test/'),
        { status: 200 },
      ],
    });
    const asked: string[] = [];
    const result = await c.check('https://a.example.test/', {
      throttle: (hostname) => {
        asked.push(hostname);
        return Promise.resolve(0);
      },
    });
    expect(result.ok).toBe(true);
    expect(asked).toEqual(['b.example.test', 'c.example.test']);
  });

  it('a redirect to the same host as the first hop is not throttled: the slot was taken by this check', async () => {
    const c = checker({ responses: [redirect('https://A.Example.test./next'), { status: 200 }] });
    const asked: string[] = [];
    const result = await c.check('https://a.example.test/', {
      throttle: (hostname) => {
        asked.push(hostname);
        return Promise.resolve(4_000);
      },
    });
    expect(result.ok).toBe(true);
    expect(asked).toEqual([]);
    expect(c.hops).toHaveLength(2);
  });

  it('a host met twice on the chain asks the throttle once', async () => {
    const c = checker({
      responses: [
        redirect('https://b.example.test/'),
        redirect('https://a.example.test/other'),
        redirect('https://b.example.test/again'),
        { status: 200 },
      ],
    });
    const asked: string[] = [];
    const result = await c.check('https://a.example.test/', {
      throttle: (hostname) => {
        asked.push(hostname);
        return Promise.resolve(0);
      },
    });
    expect(result.ok).toBe(true);
    expect(asked).toEqual(['b.example.test']);
  });

  it('the address of a redirect is verified before the throttle: a forbidden target takes no slot', async () => {
    const c = checker({
      resolve: (hostname) =>
        Promise.resolve([hostname === 'evil.example.test' ? '10.0.0.5' : PUBLIC_IP]),
      responses: [redirect('https://evil.example.test/')],
    });
    const asked: string[] = [];
    const result = await c.check('https://a.example.test/', {
      throttle: (hostname) => {
        asked.push(hostname);
        return Promise.resolve(0);
      },
    });
    expect(result).toEqual({ ok: false, reason: 'BLOCKED_ADDRESS', httpStatus: null });
    expect(asked).toEqual([]);
  });

  it('the total deadline ends a slow chain with TIMEOUT even when each hop is within its own time', async () => {
    const slow = (n: number) => () =>
      new Promise<HopResponse>((resolve) =>
        setTimeout(() => resolve(redirect(`https://next.example.test/p${n}`)), 40),
      );
    const c = checker({
      timeoutMs: 1_000,
      totalTimeoutMs: 100,
      responses: [slow(1), slow(2), slow(3), slow(4)],
    });
    const result = await c.check('https://a.example.test/');
    expect(result).toEqual({ ok: false, reason: 'TIMEOUT', httpStatus: null });
    expect(c.hops.length).toBeLessThan(4);
  });
});
