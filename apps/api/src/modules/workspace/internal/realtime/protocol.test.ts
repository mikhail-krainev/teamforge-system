import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as shared from 'shared/realtime';
import { describe, expect, it } from 'vitest';
import * as local from './protocol.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}

describe('WebSocket protocol constants', () => {
  it('match packages/shared (the api keeps its own copy, see protocol.ts)', () => {
    expect(local.WS_CLOSE_UNAUTHENTICATED).toBe(shared.WS_CLOSE_UNAUTHENTICATED);
    expect(local.WS_CLOSE_FORBIDDEN).toBe(shared.WS_CLOSE_FORBIDDEN);
    expect(local.WS_LIMITS).toEqual(shared.WS_LIMITS);
  });

  it('no api source imports runtime values from shared (the production image cannot load them)', () => {
    const offenders = sources(SRC).filter((file) =>
      /import\s+(?!type\b)[^;]*?from\s+'shared[^']*'/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
