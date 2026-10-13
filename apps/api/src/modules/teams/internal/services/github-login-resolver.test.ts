import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../../platform/config/config.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { HttpGithubLoginResolver } from './github-login-resolver.js';

describe('HttpGithubLoginResolver (SEC-18)', () => {
  let server: Server;
  let resolver: HttpGithubLoginResolver;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const login = decodeURIComponent((req.url ?? '').replace('/users/', ''));
      res.setHeader('Content-Type', 'application/json');
      if (login === 'octocat') {
        res.end(JSON.stringify({ id: 583231, login: 'octocat', type: 'User' }));
      } else if (login === 'some-org') {
        res.end(JSON.stringify({ id: 9, login: 'some-org', type: 'Organization' }));
      } else if (login === 'garbled') {
        res.end(JSON.stringify({ nope: true }));
      } else if (login === 'limited') {
        res.statusCode = 403;
        res.end('{}');
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    resolver = new HttpGithubLoginResolver({
      GITHUB_API_BASE_URL: `http://127.0.0.1:${port}`,
    } as unknown as AppConfig);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns the numeric id and the spelling GitHub reports', async () => {
    expect(await resolver.resolve('octocat')).toEqual({ id: 583231, login: 'octocat' });
  });

  it('returns null for an unknown login and for an organisation', async () => {
    expect(await resolver.resolve('nobody')).toBeNull();
    expect(await resolver.resolve('some-org')).toBeNull();
  });

  it('answers 503 when GitHub refuses, sends an unreadable body, or cannot be reached', async () => {
    for (const login of ['limited', 'garbled']) {
      await expect(resolver.resolve(login)).rejects.toMatchObject({ status: 503 });
    }
    const dead = new HttpGithubLoginResolver({
      GITHUB_API_BASE_URL: 'http://127.0.0.1:1',
    } as unknown as AppConfig);
    const error = await dead.resolve('octocat').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).status).toBe(503);
  });
});
