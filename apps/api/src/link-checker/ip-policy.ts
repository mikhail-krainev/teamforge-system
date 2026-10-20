import { isIPv4, isIPv6 } from 'node:net';

/**
 * Forbidden destination addresses of the link-checker (architecture 13.12, SEC-05, C-46): the special-purpose
 * IANA ranges plus the public addresses of our own server. Pure functions, no I/O. An address that cannot
 * be parsed is forbidden (fail closed).
 */

type Cidr4 = readonly [address: string, bits: number];

const IPV4_FORBIDDEN: readonly Cidr4[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32],
];

type Cidr6 = readonly [address: string, bits: number];

/** Ranges with `::ffff:0:0/96` and `2002::/16` handled separately: they embed an IPv4 address. */
const IPV6_FORBIDDEN: readonly Cidr6[] = [
  // `::/96` covers the unspecified address, the loopback and the deprecated IPv4-compatible form.
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

const MAPPED_PREFIX = 0xffffn << 32n;
const SIX_TO_FOUR_BITS = 16;
const IPV6_BITS = 128n;
const IPV4_BITS = 32;

function parseIpv4(text: string): bigint | undefined {
  if (!isIPv4(text)) return undefined;
  return text.split('.').reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

/** Expands `::` and an embedded dotted IPv4 tail into eight 16-bit groups. */
function parseIpv6(text: string): bigint | undefined {
  if (!isIPv6(text)) return undefined;
  let source = text.split('%')[0] ?? text;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(source);
  if (dotted?.[1] !== undefined) {
    const tail = parseIpv4(dotted[1]);
    if (tail === undefined) return undefined;
    source = `${source.slice(0, -dotted[1].length)}${(tail >> 16n).toString(16)}:${(tail & 0xffffn).toString(16)}`;
  }
  const [head = '', rest, ...extra] = source.split('::');
  if (extra.length > 0) return undefined;
  const front = head === '' ? [] : head.split(':');
  const back = rest === undefined || rest === '' ? [] : rest.split(':');
  const missing = 8 - front.length - back.length;
  if (missing < 0 || (rest === undefined && missing !== 0)) return undefined;
  const groups = [...front, ...Array<string>(rest === undefined ? 0 : missing).fill('0'), ...back];
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

function inCidr(value: bigint, base: bigint, bits: number, width: bigint): boolean {
  const shift = width - BigInt(bits);
  return value >> shift === base >> shift;
}

const forbidden4 = (value: bigint): boolean =>
  IPV4_FORBIDDEN.some(([address, bits]) => {
    const base = parseIpv4(address);
    return base !== undefined && inCidr(value, base, bits, BigInt(IPV4_BITS));
  });

const FORBIDDEN_6_PARSED = IPV6_FORBIDDEN.flatMap(([address, bits]) => {
  const base = parseIpv6(address);
  return base === undefined ? [] : [{ base, bits }];
});

function forbidden6(value: bigint): boolean {
  if (inCidr(value, MAPPED_PREFIX, 96, IPV6_BITS)) return forbidden4(value & 0xffffffffn);
  if (value >> 112n === 0x2002n) {
    const embedded = (value >> BigInt(128 - SIX_TO_FOUR_BITS - IPV4_BITS)) & 0xffffffffn;
    return forbidden4(embedded);
  }
  return FORBIDDEN_6_PARSED.some(({ base, bits }) => inCidr(value, base, bits, IPV6_BITS));
}

/** Numeric form of an address, comparable across spellings (`::ffff:1.2.3.4` equals `1.2.3.4`). */
function canonical(text: string): { family: 4 | 6; value: bigint } | undefined {
  const v4 = parseIpv4(text);
  if (v4 !== undefined) return { family: 4, value: v4 };
  const v6 = parseIpv6(text);
  if (v6 === undefined) return undefined;
  if (inCidr(v6, MAPPED_PREFIX, 96, IPV6_BITS)) return { family: 4, value: v6 & 0xffffffffn };
  return { family: 6, value: v6 };
}

/** The set of own public addresses in the canonical form used by `isForbiddenAddress`. */
export function ownAddressSet(addresses: readonly string[]): ReadonlySet<string> {
  const keys = addresses.flatMap((address) => {
    const parsed = canonical(address);
    return parsed === undefined ? [] : [`${parsed.family}:${parsed.value}`];
  });
  return new Set(keys);
}

/** True when the link-checker must not connect to `address` (a range of the list or an own address). */
export function isForbiddenAddress(address: string, own: ReadonlySet<string> = new Set()): boolean {
  const parsed = canonical(address);
  if (parsed === undefined) return true;
  if (own.has(`${parsed.family}:${parsed.value}`)) return true;
  return parsed.family === 4 ? forbidden4(parsed.value) : forbidden6(parsed.value);
}
