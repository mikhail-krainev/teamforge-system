/**
 * Fastify `trustProxy` value (architecture 13.6, SEC-16): an explicit list of proxy addresses
 * (Caddy and web), never `true`. An empty list trusts nobody, so X-Forwarded-For is ignored.
 */
export function buildTrustProxy(cidrs: readonly string[]): string[] | false {
  return cidrs.length === 0 ? false : [...cidrs];
}
