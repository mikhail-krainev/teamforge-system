import { describe, expect, it } from 'vitest';
import { validEnv } from '../../../test/helpers/env.js';
import { ConfigError, isWeakSecret, loadConfig, loadMigrateConfig } from './config.js';

function issuesOf(env: NodeJS.ProcessEnv, role: 'api' | 'worker' = 'api') {
  try {
    loadConfig(env, role);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  return [];
}

describe('loadConfig', () => {
  it('accepts a complete environment and freezes the result', () => {
    const config = loadConfig(validEnv(), 'api');
    expect(config.API_PORT).toBe(4000);
    expect(config.TRUSTED_PROXY_CIDRS).toEqual(['127.0.0.1/32']);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('S1R-12: trusts no proxy unless TRUSTED_PROXY_CIDRS says so', () => {
    expect(
      loadConfig(validEnv({ TRUSTED_PROXY_CIDRS: undefined }), 'api').TRUSTED_PROXY_CIDRS,
    ).toEqual([]);
    expect(loadConfig(validEnv({ TRUSTED_PROXY_CIDRS: '' }), 'api').TRUSTED_PROXY_CIDRS).toEqual(
      [],
    );
  });

  it('S1R-08: NODE_ENV=test is accepted only together with a loopback APP_ORIGIN', () => {
    expect(
      issuesOf(validEnv({ NODE_ENV: 'test', APP_ORIGIN: 'https://teamforge.example' })),
    ).toEqual([{ name: 'APP_ORIGIN', reason: 'invalid' }]);
    expect(issuesOf(validEnv({ NODE_ENV: 'test', APP_ORIGIN: 'http://localhost:3000' }))).toEqual(
      [],
    );
    expect(issuesOf(validEnv({ NODE_ENV: 'test', APP_ORIGIN: 'http://web.localhost' }))).toEqual(
      [],
    );
    expect(
      issuesOf(validEnv({ NODE_ENV: 'production', APP_ORIGIN: 'https://teamforge.example' })),
    ).toEqual([]);
  });

  it('reports a missing BETTER_AUTH_SECRET by name', () => {
    expect(issuesOf(validEnv({ BETTER_AUTH_SECRET: undefined }))).toEqual([
      { name: 'BETTER_AUTH_SECRET', reason: 'missing' },
    ]);
  });

  it('reports a missing DATA_ENCRYPTION_KEY by name', () => {
    expect(issuesOf(validEnv({ DATA_ENCRYPTION_KEY: '' }))).toEqual([
      { name: 'DATA_ENCRYPTION_KEY', reason: 'missing' },
    ]);
  });

  it('rejects weak secrets and malformed keys without echoing values', () => {
    const env = validEnv({ BETTER_AUTH_SECRET: 'changeme', DATA_ENCRYPTION_KEY: 'short' });
    const issues = issuesOf(env);
    expect(issues.map((i) => i.name).sort()).toEqual(['BETTER_AUTH_SECRET', 'DATA_ENCRYPTION_KEY']);
    expect(issues.every((i) => i.reason === 'invalid')).toBe(true);
    expect(JSON.stringify(issues)).not.toContain('changeme');
  });

  it('rejects a repeated-character secret', () => {
    expect(isWeakSecret('a'.repeat(40))).toBe(true);
    expect(isWeakSecret('k3Jd9sLq0Zx7Vb2Nm5Ra8Tw1Yp4Hc6Ug')).toBe(false);
  });

  it('loads the minimal migrate config without application secrets', () => {
    expect(loadMigrateConfig({ DATABASE_DIRECT_URL: 'postgres://u:p@h:5432/d' })).toEqual({
      DATABASE_DIRECT_URL: 'postgres://u:p@h:5432/d',
    });
    expect(() => loadMigrateConfig({})).toThrow(ConfigError);
  });

  it('requires SMTP settings for the worker role', () => {
    const env = validEnv({ SMTP_URL: undefined });
    expect(issuesOf(env, 'worker')).toEqual([{ name: 'SMTP_URL', reason: 'missing' }]);
  });

  it('enables strict Redis ACL checks outside the test environment', () => {
    expect(loadConfig(validEnv(), 'api').REDIS_ACL_STRICT).toBe(false);
    expect(loadConfig(validEnv({ NODE_ENV: 'production' }), 'api').REDIS_ACL_STRICT).toBe(true);
    expect(loadConfig(validEnv({ REDIS_ACL_STRICT: 'true' }), 'api').REDIS_ACL_STRICT).toBe(true);
  });

  it('rejects an invalid proxy CIDR list', () => {
    expect(issuesOf(validEnv({ TRUSTED_PROXY_CIDRS: 'not a cidr' }))).toEqual([
      { name: 'TRUSTED_PROXY_CIDRS', reason: 'invalid' },
    ]);
  });
});
