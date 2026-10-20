import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpsHop, MAX_BODY_BYTES } from './https-hop.js';
import { createLinkChecker } from './ssrf-client.js';

/*
 * The real HTTPS hop of the link-checker against a local TLS server: the connection goes to an
 * address while the certificate is judged against the original name (SNI/Host), the body is capped,
 * a late answer is abandoned. The certificate is made per run, so no key is stored in the repository.
 */

const NAME = 'checked.example.test';

let server: Server;
let port = 0;
let certificate = '';
let workdir = '';
const seen: { host?: string; url?: string; agent?: string }[] = [];

function selfSigned(): { cert: string; key: string } {
  workdir = mkdtempSync(path.join(tmpdir(), 'tf-hop-'));
  const key = path.join(workdir, 'key.pem');
  const cert = path.join(workdir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert],
      ...['-days', '2', '-subj', `/CN=${NAME}`, '-addext', `subjectAltName=DNS:${NAME}`],
    ],
    { stdio: 'ignore' },
  );
  return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') };
}

beforeAll(async () => {
  const pair = selfSigned();
  certificate = pair.cert;
  server = createServer(pair, (req, res) => {
    seen.push({ host: req.headers.host, url: req.url, agent: req.headers['user-agent'] });
    if (req.url?.startsWith('/redirect')) {
      res.writeHead(302, { location: '/landing' }).end();
    } else if (req.url?.startsWith('/big')) {
      res.writeHead(200).end(Buffer.alloc(3 * MAX_BODY_BYTES, 0x61));
    } else if (req.url?.startsWith('/hang')) {
      // never answers
    } else {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<title>ok</title>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

const hopTo = (path: string, over: { servername?: string; signal?: AbortSignal } = {}) => ({
  ip: '127.0.0.1',
  port,
  servername: over.servername ?? NAME,
  host: NAME,
  path,
  ...(over.signal ? { signal: over.signal } : {}),
});

describe('createHttpsHop', () => {
  it('connects to the given address and sends the original name as Host; the certificate is checked against that name', async () => {
    const hop = createHttpsHop({ ca: certificate });
    const answer = await hop(hopTo('/page?a=1'));
    expect(answer.status).toBe(200);
    expect(answer.body?.toString()).toContain('<title>ok</title>');
    expect(seen.at(-1)).toMatchObject({ host: NAME, url: '/page?a=1' });
    expect(seen.at(-1)?.agent).toMatch(/^TeamForge-link-check/);
  });

  it('returns the Location of a redirect without following it', async () => {
    const answer = await createHttpsHop({ ca: certificate })(hopTo('/redirect'));
    expect(answer).toMatchObject({ status: 302, location: '/landing' });
  });

  it('a certificate that does not belong to the name is refused with a TLS error code', async () => {
    const hop = createHttpsHop({ ca: certificate });
    await expect(hop(hopTo('/', { servername: 'other.example.test' }))).rejects.toMatchObject({
      code: expect.stringMatching(/CERT|ALTNAME|TLS/),
    });
  });

  it('an untrusted certificate (no extra authority) is refused', async () => {
    await expect(createHttpsHop()(hopTo('/'))).rejects.toMatchObject({
      code: expect.stringMatching(/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/),
    });
  });

  it('reads at most about 1 MiB of the body', async () => {
    const answer = await createHttpsHop({ ca: certificate })(hopTo('/big'));
    expect(answer.status).toBe(200);
    expect(answer.body?.length).toBeGreaterThanOrEqual(MAX_BODY_BYTES);
    expect(answer.body?.length).toBeLessThan(2 * MAX_BODY_BYTES);
  });

  it('abandons a request when the signal fires', async () => {
    const controller = new AbortController();
    const pending = createHttpsHop({ ca: certificate })(
      hopTo('/hang', { signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toBeDefined();
  });
});

describe('the checker with the real hop', () => {
  it('a certificate error becomes TLS_ERROR and nothing else leaks', async () => {
    // 93.184.216.34 is a public address, so the policy lets the hop through; the connection is
    // redirected to the local server by the injected request, which fails the certificate check.
    const checker = createLinkChecker({
      resolve: async () => ['93.184.216.34'],
      request: (hop) => createHttpsHop()({ ...hop, ip: '127.0.0.1', port }),
    });
    expect(await checker.check(`https://${NAME}/`)).toEqual({
      ok: false,
      reason: 'TLS_ERROR',
      httpStatus: null,
    });
  });

  it('a hop that never answers becomes TIMEOUT and the socket is released', async () => {
    const checker = createLinkChecker({
      resolve: async () => ['93.184.216.34'],
      request: (hop) =>
        createHttpsHop({ ca: certificate })({ ...hop, ip: '127.0.0.1', port, path: '/hang' }),
      timeoutMs: 100,
    });
    expect(await checker.check(`https://${NAME}/`)).toMatchObject({ ok: false, reason: 'TIMEOUT' });
  });

  it('a trusted answer is ok with its status', async () => {
    const checker = createLinkChecker({
      resolve: async () => ['93.184.216.34'],
      request: (hop) => createHttpsHop({ ca: certificate })({ ...hop, ip: '127.0.0.1', port }),
    });
    expect(await checker.check(`https://${NAME}/x`)).toEqual({
      ok: true,
      reason: null,
      httpStatus: 200,
    });
  });
});
