import { isIP } from 'node:net';
import { isForbiddenAddress, ownAddressSet } from './ip-policy.js';

/**
 * The SSRF-safe checker of user links (architecture 13.12, SEC-05, C-46). It runs only in the
 * `link-checker` process. Nothing but a code leaves it (`reason`, `httpStatus`), so a blind
 * request cannot be used to read internal pages.
 */

export type LinkCheckReason =
  | 'HTTP_STATUS'
  | 'TOO_SMALL'
  | 'PLACEHOLDER_TITLE'
  | 'TIMEOUT'
  | 'BLOCKED_ADDRESS'
  | 'BLOCKED_PORT'
  | 'TLS_ERROR'
  | 'TOO_MANY_REDIRECTS'
  | 'DNS_ERROR';

export interface LinkCheckOutcome {
  ok: boolean;
  reason: LinkCheckReason | null;
  httpStatus: number | null;
}

/** One HTTPS request: the connection goes to the verified `ip`, SNI and `Host` carry the original name. */
export interface Hop {
  ip: string;
  port: number;
  servername: string;
  host: string;
  path: string;
  /** Aborted when the hop runs out of time. */
  signal?: AbortSignal;
}

export interface HopResponse {
  status: number;
  location?: string;
  body?: Buffer;
}

export interface LinkCheckerDeps {
  /** All A and AAAA addresses of a name. */
  resolve(hostname: string): Promise<string[]>;
  request(hop: Hop): Promise<HopResponse>;
  /** Public addresses of this server: a published service must not be reachable through a check. */
  selfPublicIps?: readonly string[];
  timeoutMs?: number;
}

export const HTTPS_PORT = 443;
export const MAX_REDIRECTS = 3;
export const DEFAULT_TIMEOUT_MS = 10_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TLS_ERROR_PATTERN = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|EPROTO|ALTNAME/i;

const failure = (reason: LinkCheckReason, httpStatus: number | null = null): LinkCheckOutcome => ({
  ok: false,
  reason,
  httpStatus,
});

class TimedOut extends Error {}

/** Runs `work` with an abort signal that fires after `ms`; a late answer is ignored. */
async function withTimeout<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimedOut());
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Why a request failed, as a code: certificate problems are `TLS_ERROR`, everything else "no answer". */
function requestFailure(error: unknown): LinkCheckOutcome {
  if (error instanceof TimedOut) return failure('TIMEOUT');
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  if (typeof code === 'string' && TLS_ERROR_PATTERN.test(code)) return failure('TLS_ERROR');
  return failure('TIMEOUT');
}

type Target = { ok: true; url: URL; hostname: string } | { ok: false; outcome: LinkCheckOutcome };

/** Scheme, userinfo and port rules; the host is judged afterwards. */
function targetOf(raw: string, base?: URL): Target {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return { ok: false, outcome: failure('BLOCKED_ADDRESS') };
  }
  if (url.protocol !== 'https:') return { ok: false, outcome: failure('BLOCKED_PORT') };
  if (url.username !== '' || url.password !== '') {
    return { ok: false, outcome: failure('BLOCKED_ADDRESS') };
  }
  if (url.port !== '' && url.port !== String(HTTPS_PORT)) {
    return { ok: false, outcome: failure('BLOCKED_PORT') };
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (hostname === '') return { ok: false, outcome: failure('BLOCKED_ADDRESS') };
  return { ok: true, url, hostname };
}

interface Context {
  deps: LinkCheckerDeps;
  own: ReadonlySet<string>;
  timeoutMs: number;
}

/** The address to connect to, or the outcome that stops the check. */
async function verifiedAddress(
  { deps, own, timeoutMs }: Context,
  hostname: string,
): Promise<{ ip: string } | LinkCheckOutcome> {
  if (isIP(hostname) !== 0) {
    return isForbiddenAddress(hostname, own) ? failure('BLOCKED_ADDRESS') : { ip: hostname };
  }
  let addresses: string[];
  try {
    addresses = await withTimeout(timeoutMs, () => deps.resolve(hostname));
  } catch (error) {
    return error instanceof TimedOut ? failure('TIMEOUT') : failure('DNS_ERROR');
  }
  const first = addresses[0];
  if (first === undefined) return failure('DNS_ERROR');
  // One forbidden address in the answer blocks the name: a mixed answer is a rebinding double.
  if (addresses.some((address) => isForbiddenAddress(address, own))) {
    return failure('BLOCKED_ADDRESS');
  }
  return { ip: first };
}

/** One request to the verified address; the name is resolved once per hop and the answer is used as it was checked. */
async function hopOnce(
  context: Context,
  url: URL,
  hostname: string,
): Promise<HopResponse | LinkCheckOutcome> {
  const address = await verifiedAddress(context, hostname);
  if ('ok' in address) return address;
  try {
    return await withTimeout(context.timeoutMs, (signal) =>
      context.deps.request({
        ip: address.ip,
        port: HTTPS_PORT,
        servername: hostname,
        host: url.host.replace(`:${HTTPS_PORT}`, ''),
        path: `${url.pathname}${url.search}`,
        signal,
      }),
    );
  } catch (error) {
    return requestFailure(error);
  }
}

async function follow(context: Context, raw: string): Promise<LinkCheckOutcome> {
  let current = targetOf(raw);
  const visited = new Set<string>();
  for (let redirects = 0; ; redirects += 1) {
    if (!current.ok) return current.outcome;
    visited.add(current.url.href);
    const answer = await hopOnce(context, current.url, current.hostname);
    if ('ok' in answer) return answer;
    if (answer.status >= 200 && answer.status < 300) {
      return { ok: true, reason: null, httpStatus: answer.status };
    }
    const redirecting = REDIRECT_STATUSES.has(answer.status) && answer.location !== undefined;
    if (!redirecting) return failure('HTTP_STATUS', answer.status);
    if (redirects >= MAX_REDIRECTS) return failure('TOO_MANY_REDIRECTS');
    current = targetOf(answer.location ?? '', current.url);
    // A redirect back to a page of this very chain is a loop: no point in following it.
    if (current.ok && visited.has(current.url.href)) return failure('TOO_MANY_REDIRECTS');
  }
}

export function createLinkChecker(deps: LinkCheckerDeps): {
  check(url: string): Promise<LinkCheckOutcome>;
} {
  const context: Context = {
    deps,
    own: ownAddressSet(deps.selfPublicIps ?? []),
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  return { check: (raw) => follow(context, raw) };
}
