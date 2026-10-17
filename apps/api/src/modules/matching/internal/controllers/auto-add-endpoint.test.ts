import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { World } from '../../../../../test/fixtures/world.js';
import { createTestApp, type TestApp } from '../../../../../test/helpers/app.js';
import { describeInfra } from '../../../../../test/helpers/infra.js';
import { autoAddNowRoutes } from './auto-add-endpoint.js';

const URL = '/api/v1/_test/matching/auto-add';

describe('the test-only trigger of matching-auto-add is not registered outside NODE_ENV=test', () => {
  it('autoAddNowRoutes gives nothing for production, development and an unset variable', () => {
    for (const env of ['production', 'development', undefined]) {
      expect(autoAddNowRoutes(env)).toEqual({ controllers: [], providers: [] });
    }
    expect(autoAddNowRoutes('test').controllers).toHaveLength(1);
  });

  it('MatchingModule of a production process has no such controller or provider', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    try {
      const { MatchingModule } = await import('../../matching.module.js');
      const controllers = (Reflect.getMetadata('controllers', MatchingModule) ?? []) as {
        name: string;
      }[];
      const providers = (Reflect.getMetadata('providers', MatchingModule) ?? []) as {
        name?: string;
      }[];
      expect(controllers.map((c) => c.name)).not.toContain('AutoAddNowController');
      expect(providers.map((p) => p.name)).not.toContain('AutoAddNowOperations');
      expect(controllers.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('a process started with NODE_ENV=test registers it', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.resetModules();
    try {
      const { MatchingModule } = await import('../../matching.module.js');
      const controllers = (Reflect.getMetadata('controllers', MatchingModule) ?? []) as {
        name: string;
      }[];
      expect(controllers.map((c) => c.name)).toContain('AutoAddNowController');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describeInfra('the test-only trigger over HTTP', ['db', 'redis'], () => {
  let production: TestApp;
  let world: World;

  beforeAll(async () => {
    production = await createTestApp({
      testSupport: false,
      env: { NODE_ENV: 'production', REDIS_ACL_STRICT: 'false' },
    });
    world = await World.start({ worker: false });
  });

  afterAll(async () => {
    await Promise.all([production?.close(), world?.close()]);
  });

  it('answers 404 under a production configuration even if the class is wired', async () => {
    const response = await production.app.inject({ method: 'POST', url: URL });
    expect(response.statusCode).toBe(404);
  });

  it('runs a pass synchronously under the test configuration and reports it', async () => {
    const response = await world.app.inject({ method: 'POST', url: URL });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      runId: expect.any(String),
      applications: expect.any(Number),
      added: expect.any(Number),
      skipped: expect.any(Number),
    });
  });
});
