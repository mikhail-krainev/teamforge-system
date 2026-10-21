import { createHmac, timingSafeEqual } from 'node:crypto';

/** `sha256=` and 64 lower-case hex digits, nothing around it: a padded or upper-case header is refused. */
const SIGNATURE_FORMAT = /^sha256=[a-f0-9]{64}$/;

/**
 * `X-Hub-Signature-256` over the raw body (FR-GH-03). The header must have exactly the form GitHub
 * writes; the digests are compared in constant time. A missing secret never matches.
 */
export function isValidSignature(
  secret: string | undefined,
  rawBody: Buffer,
  header: string | string[] | undefined,
): boolean {
  if (secret === undefined || typeof header !== 'string' || !SIGNATURE_FORMAT.test(header)) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
