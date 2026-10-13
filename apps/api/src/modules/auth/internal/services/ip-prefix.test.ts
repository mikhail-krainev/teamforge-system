import { describe, expect, it } from 'vitest';
import { ipPrefix } from './identity-signals.service.js';

describe('ipPrefix (SEC-13 signal values)', () => {
  it('keeps the /24 of an IPv4 address', () => {
    expect(ipPrefix('203.0.113.77')).toBe('203.0.113.0/24');
  });

  it('keeps the /48 of a full IPv6 address', () => {
    expect(ipPrefix('2001:db8:abcd:12:0:0:0:1')).toBe('2001:db8:abcd::/48');
  });

  it('expands a compressed IPv6 address before taking the /48', () => {
    expect(ipPrefix('2001:db8::1')).toBe('2001:db8:0::/48');
    expect(ipPrefix('::1')).toBe('0:0:0::/48');
    expect(ipPrefix('fe80::')).toBe('fe80:0:0::/48');
  });

  it('returns null for anything that is not an IP address', () => {
    expect(ipPrefix('not-an-ip')).toBeNull();
    expect(ipPrefix('')).toBeNull();
    expect(ipPrefix('999.1.1.1')).toBeNull();
  });
});
