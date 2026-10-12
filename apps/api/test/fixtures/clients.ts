import { randomInt, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { type ApiClient, api } from '../helpers/api.js';
import type { InjectResponse } from '../helpers/http.js';

export interface CallOptions {
  /** Idempotency-Key: random by default, an explicit string to repeat a request, `null` to omit. */
  idempotencyKey?: string | null;
  headers?: Record<string, string>;
  /** Client IP (sent as X-Forwarded-For; the test app trusts 127.0.0.1, SEC-16). */
  ip?: string;
}

export interface UploadFile {
  field?: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** What a test can do as a caller: the same surface for header-identified users and cookie sessions. */
export interface Caller {
  request(
    method: Method,
    url: string,
    body?: unknown,
    options?: CallOptions,
  ): Promise<InjectResponse>;
  get(url: string, options?: CallOptions): Promise<InjectResponse>;
  post(url: string, body?: unknown, options?: CallOptions): Promise<InjectResponse>;
  put(url: string, body?: unknown, options?: CallOptions): Promise<InjectResponse>;
  patch(url: string, body?: unknown, options?: CallOptions): Promise<InjectResponse>;
  delete(url: string, options?: CallOptions): Promise<InjectResponse>;
  /** multipart/form-data with one file (uploadResume). */
  upload(url: string, file: UploadFile, options?: CallOptions): Promise<InjectResponse>;
}

/** A random documentation-range IP so that per-IP limits (C-31, C-32) never leak between tests. */
export function randomIp(): string {
  return `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

export function multipartBody(file: UploadFile): { payload: Buffer; contentType: string } {
  const boundary = `----tf${randomUUID().replaceAll('-', '')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'file'}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, file.data, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

abstract class BaseCaller implements Caller {
  abstract request(
    method: Method,
    url: string,
    body?: unknown,
    options?: CallOptions,
  ): Promise<InjectResponse>;

  get(url: string, options?: CallOptions): Promise<InjectResponse> {
    return this.request('GET', url, undefined, options);
  }

  post(url: string, body?: unknown, options?: CallOptions): Promise<InjectResponse> {
    return this.request('POST', url, body, options);
  }

  put(url: string, body?: unknown, options?: CallOptions): Promise<InjectResponse> {
    return this.request('PUT', url, body, options);
  }

  patch(url: string, body?: unknown, options?: CallOptions): Promise<InjectResponse> {
    return this.request('PATCH', url, body, options);
  }

  delete(url: string, options?: CallOptions): Promise<InjectResponse> {
    return this.request('DELETE', url, undefined, options);
  }

  upload(url: string, file: UploadFile, options: CallOptions = {}): Promise<InjectResponse> {
    const { payload, contentType } = multipartBody(file);
    return this.request('POST', url, payload, {
      ...options,
      headers: { ...options.headers, 'content-type': contentType },
    });
  }
}

const withIp = (options: CallOptions, origin: string): Record<string, string> => ({
  origin,
  ...(options.ip ? { 'x-forwarded-for': options.ip } : {}),
  ...options.headers,
});

/** A user identified by `X-Test-User` (the slice 1 test authenticator), always with the app Origin. */
class HeaderCaller extends BaseCaller {
  constructor(
    private readonly client: ApiClient,
    private readonly origin: string,
  ) {
    super();
  }

  request(method: Method, url: string, body?: unknown, options: CallOptions = {}) {
    return this.client.request(method, url, body, {
      idempotencyKey: options.idempotencyKey,
      headers: withIp(options, this.origin),
    });
  }
}

/**
 * A browser: keeps the cookies the server sets (Better Auth session, OAuth state) and sends them
 * back, like a real user agent. Used for the sign-in flows, where the cookie IS the identity.
 */
export class BrowserSession extends BaseCaller {
  readonly cookies = new Map<string, string>();

  constructor(
    private readonly app: NestFastifyApplication,
    readonly origin: string,
  ) {
    super();
  }

  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /** Applies `Set-Cookie` headers of a response to the jar (a cleared cookie leaves it). */
  absorb(response: InjectResponse): void {
    const raw = response.headers['set-cookie'];
    const lines = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const line of lines) {
      const [pair = '', ...attributes] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const cleared =
        value === '' ||
        attributes.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a)) ||
        attributes.some((a) => /^\s*expires\s*=\s*thu, 01 jan 1970/i.test(a));
      if (cleared) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(method: Method, url: string, body?: unknown, options: CallOptions = {}) {
    const headers: Record<string, string> = withIp(options, this.origin);
    if (this.cookies.size > 0) headers.cookie = this.cookieHeader();
    if (method !== 'GET' && options.idempotencyKey !== null) {
      headers['idempotency-key'] = options.idempotencyKey ?? randomUUID();
    }
    const response = await this.app.inject({
      method,
      url: `/api${url}`,
      headers,
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
    this.absorb(response);
    return response;
  }

  /** Follows nothing: returns the redirect target of a 3xx response as an absolute URL. */
  static locationOf(response: InjectResponse, base: string): URL {
    const location = response.headers.location;
    if (typeof location !== 'string') throw new Error(`no Location in HTTP ${response.statusCode}`);
    return new URL(location, base);
  }
}

export function callerFor(app: NestFastifyApplication, userId: string, origin: string): Caller {
  return new HeaderCaller(api(app).as(userId), origin);
}

export function anonymousCaller(app: NestFastifyApplication, origin: string): Caller {
  return new HeaderCaller(api(app).anonymous(), origin);
}
