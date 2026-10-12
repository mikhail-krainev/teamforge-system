import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { createTestDatabase, describeInfra, type TestDatabase } from '../helpers/infra.js';

const s3Env = (overrides: Record<string, string> = {}): Record<string, string> => ({
  S3_ENDPOINT: process.env.S3_TEST_ENDPOINT ?? '',
  S3_ACCESS_KEY: process.env.S3_TEST_ACCESS_KEY ?? '',
  S3_SECRET_KEY: process.env.S3_TEST_SECRET_KEY ?? '',
  ...overrides,
});

/**
 * The application only speaks the S3 API (ADR-0019), so the local backend (SeaweedFS) is checked
 * through the same HeadBucket calls that /health/ready makes: a smoke test of credentials and buckets.
 */
describeInfra('S1-08 real S3 (SeaweedFS): readiness uses HeadBucket', ['db', 'redis', 's3'], () => {
  let db: TestDatabase;
  let app: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await createTestApp({ databaseUrl: db.url, env: s3Env() });
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  it('healthReady is 200 with the real buckets resumes and artifacts', async () => {
    const response = await app.app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ checks: { s3: { status: string } } }>().checks.s3.status).toBe('ok');
  });

  it('healthReady is 503 when a bucket does not exist', async () => {
    const broken = await createTestApp({
      databaseUrl: db.url,
      env: s3Env({ S3_BUCKET_ARTIFACTS: 'no-such-bucket' }),
    });
    try {
      const response = await broken.app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(response.statusCode).toBe(503);
    } finally {
      await broken.close();
    }
  });

  it('healthReady is 503 when the access key is wrong', async () => {
    const broken = await createTestApp({
      databaseUrl: db.url,
      env: s3Env({ S3_SECRET_KEY: 'wrong-secret-key-0123456789' }),
    });
    try {
      const response = await broken.app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(response.statusCode).toBe(503);
    } finally {
      await broken.close();
    }
  });
});
