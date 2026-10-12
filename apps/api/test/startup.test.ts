import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validEnv } from './helpers/env.js';

const root = resolve(import.meta.dirname, '..');
const tsx = resolve(root, 'node_modules/tsx/dist/cli.mjs');

function start(entry: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [tsx, entry], {
    cwd: root,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('S1-03 startup without required secrets', () => {
  it('api exits with code 1 and prints variable names, never values', () => {
    const env = validEnv({ BETTER_AUTH_SECRET: undefined, DATA_ENCRYPTION_KEY: 'weak-value-xyz' });
    const result = start('src/main.ts', env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BETTER_AUTH_SECRET: missing');
    expect(result.stderr).toContain('DATA_ENCRYPTION_KEY: invalid');
    expect(result.stderr).not.toContain('weak-value-xyz');
  });

  it('worker exits with code 1 when the SMTP settings are missing', () => {
    const result = start('src/worker.ts', validEnv({ SMTP_URL: undefined, MAIL_FROM: undefined }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SMTP_URL: missing');
    expect(result.stderr).toContain('MAIL_FROM: missing');
  });

  it('migrate exits with code 1 and names DATABASE_DIRECT_URL', () => {
    const result = start('src/platform/db/migrate.ts', {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DATABASE_DIRECT_URL: missing');
  });
});
