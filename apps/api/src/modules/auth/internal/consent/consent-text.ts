import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/** `apps/api/seeds/consent`; the same relative position from `src/` and from `dist/`. */
const SEEDS_DIR = resolve(import.meta.dirname, '../../../../../seeds/consent');

const fileSchema = z.object({
  version: z.string().min(1).max(32),
  publishedAt: z.iso.datetime(),
  text: z.string().min(1),
});

export interface ConsentText {
  version: string;
  textHash: string;
  text: string;
  publishedAt: string;
}

/**
 * The current consent text: the newest file of `seeds/consent` by name. A new file means a new
 * version that every user has to accept again (FR-AUTH-03). Fails at startup when the folder is
 * empty or a file is malformed.
 */
export function loadCurrentConsentText(dir: string = SEEDS_DIR): ConsentText {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const latest = files.at(-1);
  if (latest === undefined) throw new Error(`No consent text in ${dir}`);
  const parsed = fileSchema.parse(JSON.parse(readFileSync(resolve(dir, latest), 'utf8')));
  const textHash = createHash('sha256').update(parsed.text, 'utf8').digest('hex');
  return { ...parsed, textHash };
}
