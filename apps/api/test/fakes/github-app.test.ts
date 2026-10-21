import { createSign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeClock } from '../helpers/clock.js';
import { githubIdentity, startGithubServer, type GithubServer } from './github-server.js';
import { hmacHex } from './github-webhooks.js';

/*
 * Self-test of the GitHub App double (S6-02): the tests of slice 6 trust it, so what it promises is
 * checked here and passes without any application code: App JWT, installation tokens, listing,
 * ETag, throttling with Retry-After on the controllable clock, installation flow, webhook signatures.
 */

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

function appJwt(server: GithubServer, claims: Record<string, unknown> = {}, pem?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    iss: server.app.appId,
    iat: now - 30,
    exp: now + 300,
    ...claims,
  };
  const signingInput = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(body)}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(pem ?? server.app.privateKeyPem);
  return `${signingInput}.${signature.toString('base64url')}`;
}

describe('S6-02 double of the GitHub App', () => {
  const clock = new FakeClock('2026-10-18T10:00:00Z');
  let server: GithubServer;

  const request = async (
    path: string,
    init: { method?: string; token?: string; headers?: Record<string, string> } = {},
  ) => {
    const response = await fetch(`${server.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...init.headers,
      },
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? (JSON.parse(text) as never) : (undefined as never),
    };
  };

  const tokenFor = async (installationId: number): Promise<string> => {
    const issued = await request(`/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      token: appJwt(server),
    });
    expect(issued.status).toBe(201);
    return (issued.body as { token: string }).token;
  };

  beforeAll(async () => {
    server = await startGithubServer({ clock });
  });

  afterAll(async () => {
    await server.close();
  });

  it('refuses an App JWT signed with another key, issued for another App, or expired', async () => {
    const installation = server.app.installApp({ id: 1, login: 'octo', type: 'User' });
    const url = `/app/installations/${installation.id}/access_tokens`;
    const other = (await import('node:crypto')).generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const now = Math.floor(Date.now() / 1000);
    for (const jwt of [
      appJwt(server, {}, other.privateKey),
      appJwt(server, { iss: 1 }),
      appJwt(server, { iat: now - 900, exp: now - 300 }),
      appJwt(server, { exp: now + 3600 }),
    ]) {
      expect((await request(url, { method: 'POST', token: jwt })).status).toBe(401);
    }
    expect((await request(url, { method: 'POST' })).status).toBe(401);
    expect((await request(url, { method: 'POST', token: appJwt(server) })).status).toBe(201);
  });

  it('serves repositories only with an installation token of the right installation', async () => {
    const a = server.app.installApp({ id: 10, login: 'alice', type: 'User' });
    const b = server.app.installApp({ id: 11, login: 'bob', type: 'User' });
    const repoA = server.app.addRepo(a.id, { name: 'alpha' });
    const repoB = server.app.addRepo(b.id, { name: 'beta' });
    const token = await tokenFor(a.id);
    expect((await request('/installation/repositories', { token })).body).toMatchObject({
      total_count: 1,
    });
    expect((await request(`/repositories/${repoA.id}`, { token })).status).toBe(200);
    expect((await request(`/repositories/${repoB.id}`, { token })).status).toBe(404);
    expect((await request(`/repositories/${repoA.id}`, { token: appJwt(server) })).status).toBe(
      401,
    );
    server.app.uninstall(a.id);
    expect((await request(`/repositories/${repoA.id}`, { token })).status).toBe(401);
    expect((await request(`/app/installations/${a.id}`, { token: appJwt(server) })).status).toBe(
      404,
    );
  });

  it('expires an installation token after an hour of the controllable clock', async () => {
    const installation = server.app.installApp({ id: 20, login: 'carol', type: 'User' });
    const token = await tokenFor(installation.id);
    expect((await request('/installation/repositories', { token })).status).toBe(200);
    clock.advance(61 * 60_000);
    expect((await request('/installation/repositories', { token })).status).toBe(401);
    expect(server.app.tokensIssued(installation.id)).toBe(1);
  });

  it('lists issues and pull requests with an ETag, and a 304 costs no quota', async () => {
    const installation = server.app.installApp({ id: 30, login: 'dave', type: 'User' });
    const repo = server.app.addRepo(installation.id, { name: 'gamma' });
    const issue = server.app.openIssue(repo.id, { author: { id: 5, login: 'dave' } });
    server.app.closeIssue(repo.id, issue.number);
    const pull = server.app.openPull(repo.id, { author: { id: 5, login: 'dave' } });
    server.app.mergePull(repo.id, pull.number);
    const token = await tokenFor(installation.id);
    const first = await request(
      `/repositories/${repo.id}/issues?state=closed&sort=updated&direction=asc`,
      { token },
    );
    expect((first.body as unknown[]).length).toBe(2);
    expect((first.body as { pull_request?: unknown }[])[1]?.pull_request).toBeDefined();
    const etag = first.headers.get('etag') ?? '';
    const before = server.app.quota.remaining;
    const second = await request(
      `/repositories/${repo.id}/issues?state=closed&sort=updated&direction=asc`,
      {
        token,
        headers: { 'if-none-match': etag },
      },
    );
    expect(second.status).toBe(304);
    expect(server.app.quota.remaining).toBe(before);
    const pulls = await request(`/repositories/${repo.id}/pulls?state=closed`, { token });
    expect((pulls.body as { merged_at: string | null }[])[0]?.merged_at).not.toBeNull();
    expect((pulls.body as { additions?: number }[])[0]?.additions).toBeUndefined();
    expect(
      (await request(`/repositories/${repo.id}/pulls/${pull.number}`, { token })).body,
    ).toMatchObject({ additions: 40, merged: true });
  });

  it('answers 403 with Retry-After until the clock passes it (secondary limit)', async () => {
    const installation = server.app.installApp({ id: 40, login: 'erin', type: 'User' });
    const token = await tokenFor(installation.id);
    server.app.throttle({ retryAfterSeconds: 90 });
    const blocked = await request('/installation/repositories', { token });
    expect(blocked.status).toBe(403);
    expect(Number(blocked.headers.get('retry-after'))).toBe(90);
    clock.advance(91_000);
    expect((await request('/installation/repositories', { token })).status).toBe(200);
  });

  it('paginates with a Link header and keeps the workflow-run permission', async () => {
    const installation = server.app.installApp(
      { id: 50, login: 'frank', type: 'User' },
      { permissions: { metadata: 'read', issues: 'read', pull_requests: 'read' } },
    );
    for (let i = 0; i < 3; i += 1) server.app.addRepo(installation.id, { name: `r${i}` });
    const token = await tokenFor(installation.id);
    const page = await request('/installation/repositories?per_page=2', { token });
    expect(page.headers.get('link')).toContain('rel="next"');
    const repo = server.app.addRepo(installation.id, { name: 'ci' });
    expect(
      (await request(`/repositories/${repo.id}/actions/runs?per_page=10`, { token })).status,
    ).toBe(403);
  });

  it('runs the installation flow of the S6-01 prototype: install, update, request, code once', async () => {
    const owner = githubIdentity('owner');
    const member = githubIdentity('member');
    const org = { id: 600, login: 'acme', type: 'Organization' as const, ownerIds: [owner.id] };
    const denied = server.app.install(member, org, { state: 's1' });
    expect(denied.query).toEqual({ setup_action: 'request', state: 's1' });
    const first = server.app.install(owner, org, { state: 's2' });
    expect(first.query).toMatchObject({ setup_action: 'install', state: 's2' });
    const again = server.app.install(owner, org, { state: 's3' });
    expect(again.query.installation_id).toBe(first.query.installation_id);
    expect(again.query.setup_action).toBe('update');
    expect(
      server.app.install(owner, org, { state: 's4', dropState: true }).query,
    ).not.toHaveProperty('state');
    // the code is exchanged once for a user token that lists the installation
    const exchanged = await fetch(`${server.baseUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: server.clientId,
        client_secret: server.clientSecret,
        code: first.query.code,
      }),
    });
    const userToken = ((await exchanged.json()) as { access_token: string }).access_token;
    const listed = await request('/user/installations', { token: userToken });
    expect(
      (listed.body as { installations: { id: number }[] }).installations.map((i) => i.id),
    ).toContain(Number(first.query.installation_id));
    const replay = await fetch(`${server.baseUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: server.clientId,
        client_secret: server.clientSecret,
        code: first.query.code,
      }),
    });
    expect(await replay.json()).toMatchObject({ error: 'bad_verification_code' });
    // the member never sees the owner's installation
    expect(server.app.userInstallations(member.id)).toEqual([]);
  });

  it('signs webhooks over the raw body and can sign them wrongly on purpose', () => {
    const installation = server.app.installApp({ id: 70, login: 'gina', type: 'User' });
    const repo = server.app.addRepo(installation.id, { name: 'hook' });
    const issue = server.app.openIssue(repo.id, { author: { id: 9, login: 'gina' } });
    const good = server.app.issuesEvent('opened', issue);
    expect(good.headers['x-hub-signature-256']).toBe(
      `sha256=${hmacHex(server.app.webhookSecret, good.body)}`,
    );
    expect(good.headers['x-github-event']).toBe('issues');
    const modes = [
      'invalid',
      'missing',
      'malformed',
      'wrong-secret',
      'sha1',
      'padded',
      'tampered',
    ] as const;
    for (const signature of modes) {
      const bad = server.app.issuesEvent('opened', issue, { signature });
      expect(
        bad.headers['x-hub-signature-256'] ===
          `sha256=${hmacHex(server.app.webhookSecret, bad.body)}`,
        signature,
      ).toBe(false);
    }
    const tampered = server.app.issuesEvent('opened', issue, { signature: 'tampered' });
    expect(() => JSON.parse(tampered.body)).not.toThrow();
    const same = server.app.issuesEvent('opened', issue, { deliveryId: 'fixed-id' });
    expect(same.headers['x-github-delivery']).toBe('fixed-id');
  });
});
