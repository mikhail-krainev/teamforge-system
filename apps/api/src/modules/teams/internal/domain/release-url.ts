/**
 * The release address as it is stored (FR-WORK-14, AF-02): the form the WHATWG URL parser gives, the one
 * the link checker opens. It lowers the host, turns an internationalized host into punycode, resolves
 * percent-encoding and full-width or ideographic dots in the host and drops tabs and edge spaces, so
 * `teams.release_address_key` compares hosts that are the same host. Text that is no address is kept as it is
 * (the key of it is NULL, and no repeat is found for it).
 */
export function canonicalReleaseUrl(raw: string): string {
  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}
