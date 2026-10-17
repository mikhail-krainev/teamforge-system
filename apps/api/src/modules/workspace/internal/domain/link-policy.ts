/**
 * Link policy applied when a link is saved (FR-WORK-04, FR-WORK-06, SEC-05, architecture 13.12).
 * It judges the spelling only; the connection-time check (DNS answer, redirects) belongs to the
 * link-checker (S5-09). A refusal carries no reason, so the answer stays blind.
 */

const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.lan',
  '.home.arpa',
];

function ipv4Octets(host: string): number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return octets.every((o) => o >= 0 && o <= 255) ? octets : undefined;
}

/** Special-purpose and private IPv4 ranges (RFC 1918, 6598, 3927, 5737, 2544, multicast, reserved). */
function blockedIpv4([a, b, c]: number[]): boolean {
  if (a === undefined || b === undefined || c === undefined) return true;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  return a === 203 && b === 0 && c === 113;
}

/**
 * True when the link may be stored: `https`, no credentials, the default port, and a host that is
 * not an IP literal of an internal range, an IPv6 literal, or a name that is local by its spelling.
 * `new URL` already turns `0x7f.0.0.1`, `2130706433` and `017700000001` into `127.0.0.1`.
 */
export function isStorableLink(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (url.port !== '' && url.port !== '443') return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '' || host.startsWith('[')) return false;
  const octets = ipv4Octets(host);
  if (octets !== undefined) return !blockedIpv4(octets);
  if (!host.includes('.')) return false;
  return !BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export type LinkStatus = 'ok' | 'broken' | 'rejected';

/**
 * What the answer of the link-checker makes of a saved link (FR-WORK-04, FR-PLAY-08 `link_https`):
 * an answer of 2xx is `ok`; a refusal of the SSRF policy (address, scheme, port) is `rejected`, which
 * blocks the item (the blocking part of the check); anything else is only a warning, `broken`.
 */
export function linkStatusOf(outcome: { ok: boolean; reason: string | null }): LinkStatus {
  if (outcome.ok) return 'ok';
  return outcome.reason === 'BLOCKED_ADDRESS' || outcome.reason === 'BLOCKED_PORT'
    ? 'rejected'
    : 'broken';
}
