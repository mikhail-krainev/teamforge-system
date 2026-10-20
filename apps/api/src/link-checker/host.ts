/**
 * One spelling of a host name for everything that compares names: the pause per domain (C-46) and the
 * checks of every hop. Lower case, no brackets around an IPv6 address, no trailing dot, IDN as punycode
 * (the WHATWG URL parser does the last one). `undefined` for text that is not a host.
 */
export function normalizeHostname(raw: string): string | undefined {
  const bare = raw
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  if (bare === '') return undefined;
  try {
    const host = new URL(`https://${bare.includes(':') ? `[${bare}]` : bare}`).hostname;
    const normalized = host.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    return normalized === '' ? undefined : normalized;
  } catch {
    return undefined;
  }
}
