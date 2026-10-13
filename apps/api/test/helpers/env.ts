/** Environment values for tests. Secrets are random-looking test constants, never real ones. */
export const TEST_SECRET = 'k3Jd9sLq0Zx7Vb2Nm5Ra8Tw1Yp4Hc6Ug';
export const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://teamforge:pw@127.0.0.1:6432/teamforge',
    DATABASE_DIRECT_URL: 'postgres://teamforge:pw@127.0.0.1:5432/teamforge',
    REDIS_URL: 'redis://api:pw@127.0.0.1:6379',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
    S3_ENDPOINT: 'http://127.0.0.1:9000',
    S3_ACCESS_KEY: 'minio-access',
    S3_SECRET_KEY: 'minio-secret',
    S3_BUCKET_RESUMES: 'resumes',
    S3_BUCKET_ARTIFACTS: 'artifacts',
    FILES_PUBLIC_ORIGIN: 'http://127.0.0.1:9000',
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: 'http://127.0.0.1:4000',
    APP_ORIGIN: 'http://127.0.0.1:3000',
    DATA_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    IP_HASH_SALT: TEST_SECRET,
    SMTP_URL: 'smtp://127.0.0.1:1025',
    MAIL_FROM: 'Teamforge <no-reply@localhost>',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  // The test stack talks to the API from the loopback; production refuses this flag (S2SEC-04).
  if (env.NODE_ENV === 'test' && !('RATE_LIMIT_EXEMPT_LOOPBACK' in overrides)) {
    env.RATE_LIMIT_EXEMPT_LOOPBACK = 'true';
  }
  return env;
}
