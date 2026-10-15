import type { SecretBox } from '../crypto/secret-box.js';

/**
 * Response properties holding a one-time secret (an invitation token). They are stored sealed with
 * `DATA_ENCRYPTION_KEY` in `idempotency_key.response_body` and opened again on replay, so the
 * database never keeps the plain value (architecture: tokens only as hashes / sealed).
 */
export const SEALED_RESPONSE_FIELDS: ReadonlySet<string> = new Set(['token']);

const MARK = 'sealed:';

function walk(value: unknown, convert: (secret: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => walk(item, convert));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value)) {
    out[name] =
      SEALED_RESPONSE_FIELDS.has(name) && typeof item === 'string'
        ? convert(item)
        : walk(item, convert);
  }
  return out;
}

export function sealResponse(box: SecretBox, body: unknown): unknown {
  return walk(body, (plain) => `${MARK}${box.seal(plain)}`);
}

export function openResponse(box: SecretBox, body: unknown): unknown {
  return walk(body, (stored) => {
    if (!stored.startsWith(MARK)) return stored;
    try {
      return box.open(stored.slice(MARK.length));
    } catch {
      return stored;
    }
  });
}
