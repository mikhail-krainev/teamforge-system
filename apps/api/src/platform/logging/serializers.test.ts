import { describe, expect, it } from 'vitest';
import { resolveRequestId } from '../http/request-id.js';
import { REDACT_PATHS, serializeErr, serializeReq, serializeRes } from './serializers.js';

describe('log serializers (SEC-07)', () => {
  it('serializes a request without URL, query or headers', () => {
    const req = {
      method: 'GET',
      id: 'abc-12345678',
      url: '/api/v1/x?token=SECRET',
      query: { code: 'SECRET' },
      headers: { cookie: 'SECRET' },
      routeOptions: { url: '/api/v1/x' },
    };
    const serialized = serializeReq(req);
    expect(serialized).toEqual({ method: 'GET', route: '/api/v1/x', request_id: 'abc-12345678' });
    expect(JSON.stringify(serialized)).not.toContain('SECRET');
  });

  it('falls back to "unmatched" when the route is unknown', () => {
    expect(serializeReq({ method: 'POST' }).route).toBe('unmatched');
  });

  it('serializes responses and errors without client request details', () => {
    expect(serializeRes({ statusCode: 201 })).toEqual({ statusCode: 201 });
    const error = Object.assign(new Error('failed'), {
      config: { url: 'https://x/?token=SECRET' },
    });
    const serialized = serializeErr(error);
    expect(JSON.stringify(serialized)).not.toContain('SECRET');
    expect(serialized).toMatchObject({ type: 'Error', message: 'failed' });
  });

  it('redacts the fields listed in architecture 13.4', () => {
    expect(REDACT_PATHS).toEqual(
      expect.arrayContaining([
        'req.headers.cookie',
        'req.headers.authorization',
        '*.email',
        '*.token',
        '*.text',
        '*.extractedText',
        '*.outcome',
      ]),
    );
  });
});

describe('resolveRequestId', () => {
  it('keeps a valid client id and generates a UUID v7 otherwise', () => {
    expect(resolveRequestId('client-id-12345')).toBe('client-id-12345');
    expect(resolveRequestId(['first-id-12345', 'second'])).toBe('first-id-12345');
    for (const invalid of [undefined, '', 'short', 'has spaces in it!', 'x'.repeat(65)]) {
      expect(resolveRequestId(invalid)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});
