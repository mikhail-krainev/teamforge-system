import { describe, expect, it } from 'vitest';
import { normalizeHostname } from './host.js';

describe('normalizeHostname (one spelling of a host for the throttle and the checks)', () => {
  it.each([
    ['Example.COM', 'example.com'],
    ['example.com.', 'example.com'],
    ['example.com..', 'example.com'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['bücher.example', 'xn--bcher-kva.example'],
    ['XN--BCHER-KVA.example.', 'xn--bcher-kva.example'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeHostname(raw)).toBe(expected);
  });

  it('a name that is not a host stays unusable: undefined', () => {
    expect(normalizeHostname('')).toBeUndefined();
    expect(normalizeHostname('a b')).toBeUndefined();
  });
});
