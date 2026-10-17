import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, expectRateLimited } from '../../../../test/fixtures/assertions.js';
import { expectOk } from '../../../../test/fixtures/teams.js';
import {
  itemOf,
  patchItem,
  routeTeam,
  type ChecklistItemDto,
  type RouteFixture,
} from '../../../../test/fixtures/workspace.js';
import { itemRow } from '../../../../test/fixtures/workspace-db.js';
import type { World } from '../../../../test/fixtures/world.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { startWorld } from './support.js';

/*
 * S5-01 for S5-05 and S5-09: links (FR-WORK-04, FR-WORK-06, FR-PLAY-08 link_https) and the SSRF client
 * of the link-checker (docs/architecture.md 13.12, SEC-05, C-46).
 *
 * Part 1 goes over HTTP: a link is refused at saving when it is not https or points at an address that
 * is internal by its spelling (422 LINK_REJECTED, nothing stored).
 *
 * Part 2 tests the SSRF client as a component. The plan names no interface, so this file fixes the one
 * it assumes (see `LinkCheckerModule`): `apps/api/src/link-checker/ssrf-client.ts` exports
 * `createLinkChecker({ resolve, request, selfPublicIps?, timeoutMs? })`, which returns `{ check(url) }`;
 * the DNS lookup and one HTTPS hop are injected, so no network is touched and the connection target
 * (the verified IP, SNI, Host) can be observed. The result is a code, never text: `{ ok, reason, httpStatus }`
 * with `reason` from release_check.reason. S5-09 may rename it; the cases stay.
 */

describeInfra(
  'S5 workspace: links are checked at saving (FR-WORK-04, FR-WORK-06, SEC-05)',
  ['db', 'redis'],
  () => {
    let world: World;
    let t: RouteFixture;

    beforeAll(async () => {
      world = await startWorld();
      t = await routeTeam(world);
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    const saveLink = async (linkUrl: string, key?: string) => {
      const item = await itemOf(t, 'mini_board');
      return patchItem(
        world,
        t.backend,
        t.team.id,
        item.id,
        { version: item.version, linkUrl },
        key ? { key } : {},
      );
    };

    const SPELLED_INTERNAL = [
      'https://127.0.0.1/',
      'https://127.1.2.3/admin',
      'https://169.254.169.254/latest/meta-data/',
      'https://10.0.0.5/',
      'https://172.16.0.9/',
      'https://192.168.1.1/',
      'https://100.64.0.1/',
      'https://0.0.0.0/',
      'https://[::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://[::ffff:7f00:1]/',
      'https://[::ffff:169.254.169.254]/',
      'https://[fe80::1]/',
      'https://[fd00::1]/',
      'https://[64:ff9b::7f00:1]/',
      'https://[2002:7f00:1::]/',
      'https://0x7f.0.0.1/',
      'https://2130706433/',
      'https://017700000001/',
      'https://user:pass@example.test/',
      'https://admin@example.test/',
      'https://example.test:8080/',
      'https://example.test:22/',
    ];

    const NOT_HTTPS = [
      'http://example.test/',
      'http://127.0.0.1/',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'ftp://example.test/file',
      'data:text/html,<script>alert(1)</script>',
      '//example.test/path',
    ];

    it.each(SPELLED_INTERNAL)(
      'SEC-05: %s -> 422 LINK_REJECTED; the item keeps its state',
      async (link) => {
        const before = await itemRow(world, (await itemOf(t, 'mini_board')).id);
        const response = await saveLink(link);
        expectProblem('updateChecklistItem', response, 422, 'LINK_REJECTED');
        const after = await itemRow(world, before.id);
        expect(after.version).toBe(before.version);
        expect(after.link_url).toBe(before.link_url);
      },
    );

    it.each(NOT_HTTPS)(
      'FR-WORK-04: %s -> refused (400 by the schema or 422 LINK_REJECTED), nothing stored',
      async (link) => {
        const before = await itemRow(world, (await itemOf(t, 'mini_board')).id);
        const response = await saveLink(link);
        expect([400, 422], response.body).toContain(response.statusCode);
        expect(['VALIDATION_FAILED', 'LINK_REJECTED']).toContain(
          response.json<{ code: string }>().code,
        );
        expect((await itemRow(world, before.id)).version).toBe(before.version);
      },
    );

    it('FR-WORK-06: the external link of a ritual follows the same rules: an internal address is refused', async () => {
      const kickoff = await itemOf(t, 'mini_kickoff');
      const response = await patchItem(world, t.frontend, t.team.id, kickoff.id, {
        version: kickoff.version,
        externalUrl: 'https://169.254.169.254/latest/meta-data/',
      });
      expectProblem('updateChecklistItem', response, 422, 'LINK_REJECTED');
    });

    it('FR-WORK-04: an ordinary https link (and the explicit port 443) is saved as unchecked; the check runs in the queue', async () => {
      const plain = await saveLink('https://example.test/board');
      const saved = expectOk<ChecklistItemDto>('updateChecklistItem', plain, 200);
      expect(saved).toMatchObject({
        linkUrl: 'https://example.test/board',
        linkStatus: 'unchecked',
      });
      const explicit = await patchItem(world, t.backend, t.team.id, saved.id, {
        version: saved.version,
        linkUrl: 'https://example.test:443/board',
      });
      expect(explicit.statusCode, explicit.body).toBe(200);
    });

    it('FR-WORK-04: the error never echoes the link or tells which address range matched (the answer is blind)', async () => {
      const response = await saveLink('https://169.254.169.254/latest/meta-data/');
      expect(response.body).not.toContain('169.254');
      expect(response.body.toLowerCase()).not.toMatch(/link-local|metadata|private|loopback|rfc/);
    });

    it('SEC-05, FR-AUTH-04: at most 30 link saves per hour for a user and a team -> the 31st is 429 RATE_LIMITED with Retry-After', async () => {
      const fresh = await routeTeam(world);
      const board = async () => itemOf(fresh, 'mini_board');
      for (let i = 0; i < 30; i += 1) {
        const item = await board();
        const response = await patchItem(world, fresh.backend, fresh.team.id, item.id, {
          version: item.version,
          linkUrl: `https://example.test/page-${i}`,
        });
        expect(response.statusCode, `save ${i + 1}: ${response.body}`).toBe(200);
      }
      const item = await board();
      const over = await patchItem(world, fresh.backend, fresh.team.id, item.id, {
        version: item.version,
        linkUrl: 'https://example.test/page-31',
      });
      expectRateLimited('updateChecklistItem', over);
      expect((await board()).linkUrl).toBe('https://example.test/page-29');
    });
  },
);

/* ---- part 2: the SSRF client as a component ---------------------------------------------------- */

type LinkCheckReason =
  | 'HTTP_STATUS'
  | 'TOO_SMALL'
  | 'PLACEHOLDER_TITLE'
  | 'TIMEOUT'
  | 'BLOCKED_ADDRESS'
  | 'BLOCKED_PORT'
  | 'TLS_ERROR'
  | 'TOO_MANY_REDIRECTS'
  | 'DNS_ERROR';

interface LinkCheckOutcome {
  ok: boolean;
  reason: LinkCheckReason | null;
  httpStatus: number | null;
}

interface Hop {
  /** The verified address the connection goes to (never the name: DNS rebinding). */
  ip: string;
  port: number;
  /** SNI and Host of the request: the original name. */
  servername: string;
  host: string;
  path: string;
}

interface HopResponse {
  status: number;
  location?: string;
  body?: Buffer;
}

interface LinkCheckerDeps {
  resolve(hostname: string): Promise<string[]>;
  request(hop: Hop): Promise<HopResponse>;
  selfPublicIps?: string[];
  timeoutMs?: number;
}

interface LinkCheckerModule {
  createLinkChecker(deps: LinkCheckerDeps): { check(url: string): Promise<LinkCheckOutcome> };
}

/** The module is loaded at run time: before S5-09 it does not exist, and the cases fail with that reason. */
async function loadLinkChecker(): Promise<LinkCheckerModule> {
  const specifier = '../../../link-checker/ssrf-client.js';
  const loaded = (await import(/* @vite-ignore */ specifier)) as Partial<LinkCheckerModule>;
  if (typeof loaded.createLinkChecker !== 'function') {
    throw new Error('apps/api/src/link-checker/ssrf-client.ts must export createLinkChecker(deps)');
  }
  return loaded as LinkCheckerModule;
}

const PUBLIC_IP = '93.184.216.34';
const HTML = Buffer.from(
  `<html><head><title>Работающий сервис</title></head><body>${'x'.repeat(600)}</body></html>`,
);

interface Harness {
  hops: Hop[];
  lookups: string[];
  check(url: string): Promise<LinkCheckOutcome>;
}

async function harness(options: {
  dns?: Record<string, string[]>;
  responses?: HopResponse[];
  selfPublicIps?: string[];
  timeoutMs?: number;
  hang?: boolean;
}): Promise<Harness> {
  const { createLinkChecker } = await loadLinkChecker();
  const hops: Hop[] = [];
  const lookups: string[] = [];
  const queue = [...(options.responses ?? [{ status: 200, body: HTML }])];
  const checker = createLinkChecker({
    resolve: async (hostname) => {
      lookups.push(hostname);
      const found = options.dns?.[hostname];
      if (!found) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
      return found;
    },
    request: async (hop) => {
      hops.push(hop);
      if (options.hang) return new Promise<HopResponse>(() => undefined);
      const next = queue.shift() ?? queue[0] ?? { status: 200, body: HTML };
      return next;
    },
    ...(options.selfPublicIps ? { selfPublicIps: options.selfPublicIps } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  return { hops, lookups, check: (url) => checker.check(url) };
}

describe('S5 link-checker: the SSRF client (C-46, SEC-05, architecture 13.12)', () => {
  const PUBLIC_DNS = { 'example.test': [PUBLIC_IP], 'ok.example.test': [PUBLIC_IP] };

  describe('forbidden addresses written as the host -> BLOCKED_ADDRESS, no request, no lookup', () => {
    const LITERALS = [
      'https://127.0.0.1/',
      'https://127.255.255.254/',
      'https://169.254.169.254/latest/meta-data/',
      'https://10.0.0.1/',
      'https://172.16.0.1/',
      'https://172.31.255.255/',
      'https://192.168.0.1/',
      'https://100.64.0.1/',
      'https://0.0.0.0/',
      'https://192.0.2.10/',
      'https://198.18.0.1/',
      'https://198.51.100.7/',
      'https://203.0.113.9/',
      'https://224.0.0.1/',
      'https://240.0.0.1/',
      'https://255.255.255.255/',
      'https://[::1]/',
      'https://[::]/',
      'https://[::ffff:127.0.0.1]/',
      'https://[::ffff:a9fe:a9fe]/',
      'https://[::ffff:10.0.0.1]/',
      'https://[64:ff9b::7f00:1]/',
      'https://[64:ff9b:1::a00:1]/',
      'https://[100::1]/',
      'https://[2001:db8::1]/',
      'https://[2002:7f00:1::]/',
      'https://[2002:a9fe:a9fe::1]/',
      'https://[fc00::1]/',
      'https://[fd12:3456::1]/',
      'https://[fe80::1]/',
      'https://[ff02::1]/',
      'https://2130706433/',
      'https://0x7f.0.0.1/',
      'https://017700000001/',
      'https://127.1/',
    ];

    it.each(LITERALS)('%s', async (url) => {
      const h = await harness({ dns: PUBLIC_DNS });
      const result = await h.check(url);
      expect(result).toMatchObject({ ok: false, reason: 'BLOCKED_ADDRESS' });
      expect(h.hops).toEqual([]);
    });
  });

  describe('names that resolve to forbidden addresses', () => {
    it('a name that resolves to a private address -> BLOCKED_ADDRESS, the connection is never made', async () => {
      const h = await harness({ dns: { 'internal.example.test': ['10.1.2.3'] } });
      expect(await h.check('https://internal.example.test/')).toMatchObject({
        ok: false,
        reason: 'BLOCKED_ADDRESS',
      });
      expect(h.hops).toEqual([]);
    });

    it('a name that resolves to loopback or link-local over AAAA only -> BLOCKED_ADDRESS', async () => {
      const h = await harness({
        dns: { 'v6.example.test': ['::1'], 'meta.example.test': ['fe80::1'] },
      });
      expect(await h.check('https://v6.example.test/')).toMatchObject({
        reason: 'BLOCKED_ADDRESS',
      });
      expect(await h.check('https://meta.example.test/')).toMatchObject({
        reason: 'BLOCKED_ADDRESS',
      });
    });

    it('DNS rebinding double: one public and one internal address in the answer -> BLOCKED_ADDRESS (any forbidden address blocks)', async () => {
      const h = await harness({ dns: { 'rebind.example.test': [PUBLIC_IP, '127.0.0.1'] } });
      expect(await h.check('https://rebind.example.test/')).toMatchObject({
        ok: false,
        reason: 'BLOCKED_ADDRESS',
      });
      expect(h.hops).toEqual([]);
    });

    it('DNS rebinding double: the answer changes between lookups -> the connection goes to the address that was checked, the name is resolved once per hop', async () => {
      const { createLinkChecker } = await loadLinkChecker();
      let lookups = 0;
      const hops: Hop[] = [];
      const checker = createLinkChecker({
        resolve: async () => {
          lookups += 1;
          return lookups === 1 ? [PUBLIC_IP] : ['127.0.0.1'];
        },
        request: async (hop) => {
          hops.push(hop);
          return { status: 200, body: HTML };
        },
      });
      const result = await checker.check('https://flip.example.test/page');
      expect(result).toMatchObject({ ok: true, httpStatus: 200 });
      expect(lookups).toBe(1);
      expect(hops).toHaveLength(1);
      expect(hops[0]).toMatchObject({
        ip: PUBLIC_IP,
        port: 443,
        servername: 'flip.example.test',
        host: 'flip.example.test',
        path: '/page',
      });
    });

    it('SELF_PUBLIC_IPS: a name that resolves to a public address of our own server -> BLOCKED_ADDRESS', async () => {
      const h = await harness({
        dns: { 'self.example.test': ['203.0.114.7'] },
        selfPublicIps: ['203.0.114.7'],
      });
      expect(await h.check('https://self.example.test/')).toMatchObject({
        ok: false,
        reason: 'BLOCKED_ADDRESS',
      });
      const other = await harness({ dns: { 'self.example.test': ['203.0.114.7'] } });
      expect(await other.check('https://self.example.test/')).toMatchObject({ ok: true });
    });
  });

  describe('scheme, port and userinfo -> BLOCKED_*, no request', () => {
    it('http: is never requested', async () => {
      const h = await harness({ dns: PUBLIC_DNS });
      const result = await h.check('http://example.test/');
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/^BLOCKED_/);
      expect(h.hops).toEqual([]);
    });

    it.each([
      'ftp://example.test/',
      'file:///etc/passwd',
      'gopher://example.test/',
      'javascript:alert(1)',
    ])('%s is refused', async (url) => {
      const h = await harness({ dns: PUBLIC_DNS });
      const result = await h.check(url);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/^BLOCKED_/);
      expect(h.hops).toEqual([]);
    });

    it.each([
      'https://example.test:8080/',
      'https://example.test:8443/',
      'https://example.test:22/',
      'https://example.test:80/',
    ])('%s -> BLOCKED_PORT (only 443)', async (url) => {
      const h = await harness({ dns: PUBLIC_DNS });
      expect(await h.check(url)).toMatchObject({ ok: false, reason: 'BLOCKED_PORT' });
      expect(h.hops).toEqual([]);
    });

    it('userinfo in the URL is refused', async () => {
      const h = await harness({ dns: PUBLIC_DNS });
      for (const url of [
        'https://user:pass@example.test/',
        'https://admin@example.test/',
        'https://example.test@127.0.0.1/',
      ]) {
        const result = await h.check(url);
        expect(result.ok, url).toBe(false);
        expect(result.reason, url).toMatch(/^BLOCKED_/);
      }
      expect(h.hops).toEqual([]);
    });

    it('the explicit port 443 is allowed and the request carries SNI and Host of the name', async () => {
      const h = await harness({ dns: PUBLIC_DNS });
      expect(await h.check('https://example.test:443/a?b=1')).toMatchObject({
        ok: true,
        httpStatus: 200,
      });
      expect(h.hops[0]).toMatchObject({
        ip: PUBLIC_IP,
        port: 443,
        servername: 'example.test',
        path: '/a?b=1',
      });
    });
  });

  describe('redirects (up to 3, each hop is checked again)', () => {
    it('a redirect to the metadata address -> BLOCKED_ADDRESS, only the first hop was requested', async () => {
      const h = await harness({
        dns: PUBLIC_DNS,
        responses: [{ status: 302, location: 'https://169.254.169.254/latest/meta-data/' }],
      });
      expect(await h.check('https://example.test/go')).toMatchObject({
        ok: false,
        reason: 'BLOCKED_ADDRESS',
      });
      expect(h.hops).toHaveLength(1);
    });

    it('a redirect to a name that resolves to an internal address -> BLOCKED_ADDRESS', async () => {
      const h = await harness({
        dns: { ...PUBLIC_DNS, 'inner.example.test': ['10.0.0.8'] },
        responses: [{ status: 301, location: 'https://inner.example.test/' }],
      });
      expect(await h.check('https://example.test/')).toMatchObject({
        ok: false,
        reason: 'BLOCKED_ADDRESS',
      });
      expect(h.hops).toHaveLength(1);
    });

    it('a redirect to port 8080 -> BLOCKED_PORT; to a URL with userinfo -> BLOCKED_*; to a relative path stays on the host', async () => {
      const port = await harness({
        dns: PUBLIC_DNS,
        responses: [{ status: 302, location: 'https://example.test:8080/' }],
      });
      expect(await port.check('https://example.test/')).toMatchObject({ reason: 'BLOCKED_PORT' });
      const userinfo = await harness({
        dns: PUBLIC_DNS,
        responses: [{ status: 302, location: 'https://u:p@example.test/' }],
      });
      expect((await userinfo.check('https://example.test/')).reason).toMatch(/^BLOCKED_/);
      const relative = await harness({
        dns: PUBLIC_DNS,
        responses: [
          { status: 302, location: '/next' },
          { status: 200, body: HTML },
        ],
      });
      expect(await relative.check('https://example.test/')).toMatchObject({ ok: true });
      expect(relative.hops[1]).toMatchObject({
        host: 'example.test',
        path: '/next',
        ip: PUBLIC_IP,
      });
    });

    it('three redirects are followed; the fourth -> TOO_MANY_REDIRECTS', async () => {
      const hop = (n: number): HopResponse => ({
        status: 302,
        location: `https://ok.example.test/${n}`,
      });
      const three = await harness({
        dns: PUBLIC_DNS,
        responses: [hop(1), hop(2), hop(3), { status: 200, body: HTML }],
      });
      expect(await three.check('https://example.test/')).toMatchObject({
        ok: true,
        httpStatus: 200,
      });
      const four = await harness({
        dns: PUBLIC_DNS,
        responses: [hop(1), hop(2), hop(3), hop(4), { status: 200, body: HTML }],
      });
      expect(await four.check('https://example.test/')).toMatchObject({
        ok: false,
        reason: 'TOO_MANY_REDIRECTS',
      });
    });

    it('a redirect loop ends with TOO_MANY_REDIRECTS', async () => {
      const h = await harness({
        dns: PUBLIC_DNS,
        responses: [{ status: 302, location: 'https://example.test/' }],
      });
      expect(await h.check('https://example.test/')).toMatchObject({
        ok: false,
        reason: 'TOO_MANY_REDIRECTS',
      });
    });
  });

  describe('outcomes are codes only (the check stays blind)', () => {
    it('200 -> ok with the status; 404 and 500 -> HTTP_STATUS with the status', async () => {
      expect(await (await harness({ dns: PUBLIC_DNS })).check('https://example.test/')).toEqual({
        ok: true,
        reason: null,
        httpStatus: 200,
      });
      const missing = await harness({
        dns: PUBLIC_DNS,
        responses: [{ status: 404, body: Buffer.from('secret internal page') }],
      });
      expect(await missing.check('https://example.test/')).toEqual({
        ok: false,
        reason: 'HTTP_STATUS',
        httpStatus: 404,
      });
      const broken = await harness({
        dns: PUBLIC_DNS,
        responses: [{ status: 500, body: Buffer.from('stack trace: /srv/app/db.js') }],
      });
      expect(await broken.check('https://example.test/')).toEqual({
        ok: false,
        reason: 'HTTP_STATUS',
        httpStatus: 500,
      });
    });

    it('a name that does not resolve -> DNS_ERROR; a hop that never answers -> TIMEOUT', async () => {
      const unknown = await harness({ dns: {} });
      expect(await unknown.check('https://nowhere.example.test/')).toMatchObject({
        ok: false,
        reason: 'DNS_ERROR',
      });
      const slow = await harness({ dns: PUBLIC_DNS, hang: true, timeoutMs: 50 });
      expect(await slow.check('https://example.test/')).toMatchObject({
        ok: false,
        reason: 'TIMEOUT',
      });
    });

    it('the result carries nothing but ok, reason and httpStatus: no body, headers or error text', async () => {
      const results = [
        await (
          await harness({
            dns: PUBLIC_DNS,
            responses: [{ status: 403, body: Buffer.from('<h1>internal admin</h1>') }],
          })
        ).check('https://example.test/'),
        await (await harness({ dns: {} })).check('https://nowhere.example.test/'),
        await (await harness({ dns: PUBLIC_DNS })).check('https://127.0.0.1/'),
      ];
      for (const result of results) {
        expect(Object.keys(result).sort()).toEqual(['httpStatus', 'ok', 'reason']);
        expect(JSON.stringify(result)).not.toMatch(/internal admin|ENOTFOUND|127\.0\.0\.1/);
      }
    });
  });
});

/* ---- part 3: the link-checker does not reach the database --------------------------------------- */

describe('S5 link-checker: the container has no access to PostgreSQL and S3 (SEC-05, architecture 2)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

  const serviceBlock = (name: string): string => {
    const text = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => l === `  ${name}:`);
    if (start < 0) throw new Error(`docker-compose.yml has no service ${name}`);
    const end = lines.findIndex((l, i) => i > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
    return lines.slice(start, end < 0 ? undefined : end).join('\n');
  };

  it('S5-09: the compose file defines the link-checker service', () => {
    expect(serviceBlock('link-checker').length).toBeGreaterThan(20);
  });

  it('SEC-05: the service gets no database, S3, session or GitHub variables, only its Redis user', () => {
    const block = serviceBlock('link-checker');
    for (const forbidden of [
      'DATABASE_URL',
      'DATABASE_DIRECT_URL',
      'S3_',
      'BETTER_AUTH',
      'GITHUB_',
      'DATA_ENCRYPTION_KEY',
      'REDIS_URL:',
    ]) {
      expect(block, forbidden).not.toContain(forbidden);
    }
    expect(block).toContain('REDIS_LINKCHECK_URL');
  });

  it('SEC-05: the service is not on the internal network (where PostgreSQL, PgBouncer and S3 live) and has an exit to the internet', () => {
    const block = serviceBlock('link-checker');
    expect(block).toMatch(/\bchecker-net\b/);
    expect(block).toMatch(/\begress\b/);
    expect(block).not.toMatch(/^\s+- internal\s*$/m);
    expect(block).not.toMatch(/^\s+internal:\s*$/m);
    expect(block).not.toMatch(/\bports:/);
  });
});
