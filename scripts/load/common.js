// Shared helpers of the k6 scenarios (docs/release.md, section 5). k6 runs this as an ES module in its
// own JS runtime (no Node APIs). The fixture comes from `node scripts/load/prepare.mjs`.
import http from 'k6/http';
import { Counter } from 'k6/metrics';

export const fixture = JSON.parse(open('/work/.data/fixture.json'));

// The container reaches the host-published api port through host.docker.internal (Docker Desktop and,
// with --add-host=host.docker.internal:host-gateway, Linux).
export const BASE = __ENV.LOAD_API_URL || 'http://host.docker.internal:24000';
// CSRF: state-changing requests must carry the origin the api was configured with (APP_ORIGIN).
export const ORIGIN = __ENV.LOAD_ORIGIN || 'http://localhost:23000';

/** Invariant violations: any value above zero fails the run (threshold `cc_violations: count==0`). */
export const violations = new Counter('cc_violations');

// 409 is an expected answer in every scenario; 429, 5xx and 401 are not, so they count as failed requests.
http.setResponseCallback(http.expectedStatuses(200, 201, 202, 409));

/** The common thresholds; `write` requests of 20 parallel callers must stay within 1000 ms (spec 5.2). */
export const thresholds = {
  cc_violations: ['count==0'],
  http_req_failed: ['rate==0'],
  'http_req_duration{kind:write}': ['p(95)<1000'],
  'http_req_duration{kind:read}': ['p(95)<300'],
  checks: ['rate==1'],
};

export function uuid() {
  const hex = () =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-a${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

/** A request object for http.batch(): JSON body, session cookie, CSRF origin and a fresh Idempotency-Key. */
export function writeRequest(method, path, cookie, body, name) {
  const headers = { Origin: ORIGIN, Cookie: cookie, 'Idempotency-Key': uuid() };
  // A Content-Type without a body is a 400 (the operation takes no body).
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return {
    method,
    url: `${BASE}/api${path}`,
    body: body === undefined ? null : JSON.stringify(body),
    params: { headers, tags: { name, kind: 'write' } },
  };
}

export function readRequest(path, cookie, name) {
  return {
    method: 'GET',
    url: `${BASE}/api${path}`,
    params: { headers: { Origin: ORIGIN, Cookie: cookie }, tags: { name, kind: 'read' } },
  };
}

/** The `code` of a problem+json answer, or '' when the body is not JSON. */
export function codeOf(response) {
  try {
    return response.json('code') || '';
  } catch {
    return '';
  }
}

/**
 * The race invariant: among `responses` exactly `wins` carry `winStatus`, every other one is a 409 with a code
 * from `loseCodes`. Anything else is a violation (logged once with its context).
 */
export function expectRace(label, responses, winStatus, wins, loseCodes) {
  let won = 0;
  const strange = [];
  for (const r of responses) {
    if (r.status === winStatus) {
      won += 1;
    } else if (r.status !== 409 || loseCodes.indexOf(codeOf(r)) < 0) {
      strange.push(`${r.status} ${codeOf(r)}`);
    }
  }
  if (won !== wins || strange.length > 0) {
    violations.add(1);
    console.error(
      `${label}: expected ${wins} x ${winStatus} and the rest 409 ${JSON.stringify(loseCodes)}; ` +
        `got ${won} x ${winStatus}, unexpected: ${JSON.stringify(strange.slice(0, 5))}`,
    );
  }
  return won;
}
