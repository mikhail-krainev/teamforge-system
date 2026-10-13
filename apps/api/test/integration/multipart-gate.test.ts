import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_GATE } from '../../src/platform/authz/actor-policies.js';
import { rateLimitedError, RateLimiter } from '../../src/platform/ratelimit/rate-limiter.js';
import { multipartParser } from '../../src/platform/http/multipart.js';
import { multipartBody } from '../fixtures/clients.js';
import { createTestApp, type TestApp } from '../helpers/app.js';

// S2SEC-01. No database or Redis is touched: consent and the rate limiter are doubles, the session
// is the header-based test one. What matters is what happens BEFORE the body is read.
const RESUME = '/api/v1/me/resume';
const form = () =>
  multipartBody({
    filename: 'cv.pdf',
    contentType: 'application/pdf',
    data: Buffer.from('%PDF-1.4 tiny'),
  });

describe('S2SEC-01: multipart is admitted before its body is read', () => {
  let testApp: TestApp;
  const assertBelowLimit = vi.fn(async () => undefined);
  const consentCheck = vi.fn(async () => undefined);
  const parse = vi.spyOn(multipartParser, 'parse');

  beforeAll(async () => {
    testApp = await createTestApp({}, (builder) =>
      builder
        .overrideProvider(CONSENT_GATE)
        .useValue({ check: consentCheck })
        .overrideProvider(RateLimiter)
        .useValue({ assertBelowLimit, userSubject: (id: string) => `user:${id}` }),
    );
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(() => {
    parse.mockClear();
    assertBelowLimit.mockClear();
    consentCheck.mockClear();
  });

  const post = (url: string, headers: Record<string, string> = {}, payload = form()) =>
    testApp.app.inject({
      method: 'POST',
      url,
      payload: payload.payload,
      headers: { 'content-type': payload.contentType, ...headers },
    });

  const problem = (response: { json: () => unknown }) => response.json() as { code: string };

  it('an anonymous multipart request to uploadResume -> 401 and the parser is not called', async () => {
    const response = await post(RESUME);
    expect(response.statusCode, response.body).toBe(401);
    expect(String(response.headers['content-type'])).toContain('application/problem+json');
    expect(problem(response).code).toBe('UNAUTHENTICATED');
    expect(parse).not.toHaveBeenCalled();
    expect(consentCheck).not.toHaveBeenCalled();
  });

  it.each([
    ['sign-in/magic-link', '/api/auth/sign-in/magic-link', {}],
    ['a signed-in user on another route', '/api/v1/me/profile', { 'x-test-user': 'u-1' }],
    ['an unknown route', '/api/v1/nothing-here', {}],
  ])('multipart to %s -> 415 and the parser is not called', async (_name, url, headers) => {
    const response = await post(url, headers);
    expect(response.statusCode, response.body).toBe(415);
    expect(problem(response).code).toBe('FILE_TYPE_REJECTED');
    expect(parse).not.toHaveBeenCalled();
  });

  it('a signed-in user without consent -> 403 before the body is read', async () => {
    consentCheck.mockRejectedValueOnce(Object.assign(new Error('consent'), { statusCode: 403 }));
    const response = await post(RESUME, { 'x-test-user': 'u-1' });
    expect(response.statusCode, response.body).toBe(403);
    expect(parse).not.toHaveBeenCalled();
  });

  it('a user over the C-33 limit -> 429 before the body is read', async () => {
    assertBelowLimit.mockRejectedValueOnce(
      rateLimitedError({
        allowed: false,
        limit: 5,
        remaining: 0,
        retryAfterSeconds: 60,
        resetSeconds: 60,
      }),
    );
    const response = await post(RESUME, { 'x-test-user': 'u-1' });
    expect(response.statusCode, response.body).toBe(429);
    expect(response.headers['retry-after']).toBe('60');
    expect(parse).not.toHaveBeenCalled();
    expect(assertBelowLimit).toHaveBeenCalledWith('resumeUpload', 'user:u-1');
  });

  it('a declared Content-Length above the cut-off -> 413 FILE_TOO_LARGE without reading', async () => {
    const response = await post(RESUME, {
      'x-test-user': 'u-1',
      'content-length': String(6 * 1024 * 1024),
    });
    expect(response.statusCode, response.body).toBe(413);
    expect(problem(response).code).toBe('FILE_TOO_LARGE');
    expect(parse).not.toHaveBeenCalled();
  });

  it('a body that grows past 5 MiB + overhead is cut -> 413 FILE_TOO_LARGE, the parser is not reached', async () => {
    const big = multipartBody({
      filename: 'big.pdf',
      contentType: 'application/pdf',
      data: Buffer.alloc(5 * 1024 * 1024 + 128 * 1024, 0x20),
    });
    const response = await testApp.app.inject({
      method: 'POST',
      url: RESUME,
      // The request is sent in chunks without a Content-Length: only the counting stream can stop it.
      payload: Readable.from(
        (async function* () {
          for (let at = 0; at < big.payload.length; at += 64 * 1024) {
            yield big.payload.subarray(at, at + 64 * 1024);
          }
        })(),
      ) as never,
      headers: { 'content-type': big.contentType, 'x-test-user': 'u-1' },
    });
    expect(response.statusCode, response.body).toBe(413);
    expect(problem(response).code).toBe('FILE_TOO_LARGE');
    expect(parse).not.toHaveBeenCalled();
  });

  it('a small multipart request of a signed-in user reaches the parser (the route is allowed)', async () => {
    const response = await post(RESUME, { 'x-test-user': 'u-1' });
    expect([401, 415, 413, 429]).not.toContain(response.statusCode);
    expect(parse).toHaveBeenCalledOnce();
    expect(assertBelowLimit).toHaveBeenCalledOnce();
  });
});
