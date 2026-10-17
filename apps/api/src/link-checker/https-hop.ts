import { lookup } from 'node:dns/promises';
import { request, type RequestOptions } from 'node:https';
import type { Hop, HopResponse } from './ssrf-client.js';

/** The answer body is read up to this size (architecture 13.12); the rest is dropped. */
export const MAX_BODY_BYTES = 1024 * 1024;

const USER_AGENT = 'TeamForge-link-check/1.0';

/** All A and AAAA addresses of a name, in the order the resolver gives them. */
export async function resolveAddresses(hostname: string): Promise<string[]> {
  const found = await lookup(hostname, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
}

export interface HttpsHopOptions {
  /** Extra trusted certificate authority (PEM). Only tests pass it; production uses the system store. */
  ca?: string;
}

/**
 * One HTTPS GET to an address that was already checked. A fresh agent per request: the process
 * environment's proxy variables are not honoured, and nothing is reused between hosts. The
 * certificate is verified against the original name (`servername`), never against the address.
 */
export function createHttpsHop(options: HttpsHopOptions = {}): (hop: Hop) => Promise<HopResponse> {
  return (hop) =>
    new Promise<HopResponse>((resolve, reject) => {
      const settings: RequestOptions = {
        host: hop.ip,
        port: hop.port,
        servername: hop.servername,
        method: 'GET',
        path: hop.path,
        agent: false,
        rejectUnauthorized: true,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
        ...(hop.signal === undefined ? {} : { signal: hop.signal }),
        headers: {
          host: hop.host,
          'user-agent': USER_AGENT,
          accept: '*/*',
          'accept-encoding': 'identity',
          connection: 'close',
        },
      };
      const req = request(settings, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = (): void => {
          const location = res.headers.location;
          resolve({
            status: res.statusCode ?? 0,
            ...(location === undefined ? {} : { location }),
            body: Buffer.concat(chunks),
          });
        };
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          size += chunk.length;
          if (size >= MAX_BODY_BYTES) {
            res.destroy();
            finish();
          }
        });
        res.on('end', finish);
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
}
