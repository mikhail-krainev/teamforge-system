import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCurrentConsentText } from './consent-text.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seed(files: Record<string, object>): string {
  const dir = mkdtempSync(join(tmpdir(), 'consent-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(content));
  }
  return dir;
}

const entry = (version: string, text: string) => ({
  version,
  text,
  publishedAt: '2026-10-13T00:00:00.000Z',
});

describe('loadCurrentConsentText', () => {
  it('reads the repository seed: names the transfer to GitHub and hashes the text with SHA-256', () => {
    const current = loadCurrentConsentText();
    expect(current.text).toContain('GitHub');
    expect(current.textHash).toBe(createHash('sha256').update(current.text, 'utf8').digest('hex'));
  });

  it('takes the newest file by name, so a new file is a new version', () => {
    const dir = seed({
      '2026-01-01.json': entry('2026-01-01', 'old'),
      '2026-06-01.json': entry('2026-06-01', 'new'),
    });
    expect(loadCurrentConsentText(dir)).toMatchObject({ version: '2026-06-01', text: 'new' });
  });

  it('fails on an empty folder and on a malformed file', () => {
    expect(() => loadCurrentConsentText(seed({}))).toThrow(/No consent text/);
    expect(() => loadCurrentConsentText(seed({ 'a.json': { version: 'x' } }))).toThrow();
  });
});
