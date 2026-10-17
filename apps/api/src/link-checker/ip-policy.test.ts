import { describe, expect, it } from 'vitest';
import { isForbiddenAddress, ownAddressSet } from './ip-policy.js';

describe('isForbiddenAddress', () => {
  it.each([
    '0.1.2.3',
    '10.255.255.255',
    '100.127.255.255',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.88.99.1',
    '192.168.1.1',
    '198.19.255.255',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::7f00:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.1.2.3',
    '64:ff9b::808:808',
    '64:ff9b:1::1',
    '100::1',
    '2001::1',
    '2001:1ff::1',
    '2001:db8::1',
    '2002:7f00:1::',
    '2002:c0a8:101::1',
    'fc00::1',
    'fdff::1',
    'fe80::1',
    'febf::1',
    'ff02::1',
    'not an address',
    '',
  ])('%s is forbidden', (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each([
    '93.184.216.34',
    '1.1.1.1',
    '100.63.255.255',
    '100.128.0.1',
    '172.15.255.255',
    '172.32.0.1',
    '192.0.1.1',
    '198.17.255.255',
    '198.20.0.1',
    '223.255.255.255',
    '::ffff:93.184.216.34',
    '2606:2800:220:1:248:1893:25c8:1946',
    '2001:200::1',
    '2002:5db8:d822::1',
    '2a00:1450:4001:81b::200e',
  ])('%s is allowed', (address) => {
    expect(isForbiddenAddress(address)).toBe(false);
  });

  it('own public addresses are forbidden in every spelling', () => {
    const own = ownAddressSet(['203.0.114.7', '2a01:4f8::1']);
    expect(isForbiddenAddress('203.0.114.7', own)).toBe(true);
    expect(isForbiddenAddress('::ffff:203.0.114.7', own)).toBe(true);
    expect(isForbiddenAddress('2a01:4f8:0:0:0:0:0:1', own)).toBe(true);
    expect(isForbiddenAddress('203.0.114.8', own)).toBe(false);
  });

  it('a malformed own address is ignored instead of matching everything', () => {
    const own = ownAddressSet(['', 'nonsense']);
    expect(own.size).toBe(0);
    expect(isForbiddenAddress('93.184.216.34', own)).toBe(false);
  });
});
