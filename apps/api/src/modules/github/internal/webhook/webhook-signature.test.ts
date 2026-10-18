import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isValidSignature } from './webhook-signature.js';

const SECRET = 'a-webhook-secret-of-some-length';
const body = Buffer.from('{"zen":"Keep it logically awesome."}');
const digest = createHmac('sha256', SECRET).update(body).digest('hex');

describe('isValidSignature (FR-GH-03)', () => {
  it('accepts the digest of the raw body', () => {
    expect(isValidSignature(SECRET, body, `sha256=${digest}`)).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['without the algorithm', digest],
    ['legacy sha1', `sha1=${digest.slice(0, 40)}`],
    ['padded', ` sha256=${digest} `],
    ['upper case', `sha256=${digest.toUpperCase()}`],
    ['too short', `sha256=${digest.slice(1)}`],
    ['another digest', `sha256=${'0'.repeat(64)}`],
    ['repeated header', [`sha256=${digest}`, `sha256=${digest}`]],
  ])('refuses a header that is %s', (_name, header) => {
    expect(isValidSignature(SECRET, body, header)).toBe(false);
  });

  it('refuses a changed body and a missing secret', () => {
    expect(isValidSignature(SECRET, Buffer.from('{}'), `sha256=${digest}`)).toBe(false);
    expect(isValidSignature(undefined, body, `sha256=${digest}`)).toBe(false);
  });
});
