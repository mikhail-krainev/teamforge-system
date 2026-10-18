import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import { resolveRequestId } from '../http/request-id.js';
import {
  REDACT_PATHS,
  sanitizeDatabaseError,
  serializeErr,
  serializeReq,
  serializeRes,
} from './serializers.js';

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

  it('cuts the query string and fragment of any URL in an error message or stack: user links carry tokens', () => {
    const error = new Error(
      'request to https://files.example.test/doc?X-Amz-Signature=SECRET&token=SECRET2#frag failed',
    );
    error.stack = `Error: ${error.message}\n    at run (file.ts:1:1)`;
    const serialized = serializeErr(error);
    const text = JSON.stringify(serialized);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('frag');
    expect(serialized['message']).toBe(
      'request to https://files.example.test/doc?[redacted] failed',
    );
    expect(serializeErr(new Error('no url here: a?b=c'))['message']).toBe('no url here: a?b=c');
  });

  it('masks userinfo of any URL in a message, a stack and the causes (https://user:pass@host)', () => {
    const inner = new Error('connect to https://alice:hunter2@files.example.test/doc failed');
    const outer = new Error('fetch failed', { cause: inner });
    outer.stack = `Error: fetch failed\n    at run (https://bob:pw9@host.test/x.js:1:1)`;
    const serialized = serializeErr(outer);
    const text = JSON.stringify(serialized);
    for (const secret of ['alice', 'hunter2', 'bob', 'pw9']) expect(text).not.toContain(secret);
    expect(text).toContain('https://[redacted]@files.example.test/doc');
    expect(serializeErr(new Error('mail a@b.test and https://host.test/p@q'))['message']).toBe(
      'mail a@b.test and https://host.test/p@q',
    );
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

const EMAIL = 'alice@example.com';
const TOKEN = 'SESSION-TOKEN-123';

describe('database error serialization (S1R-01, SEC-07)', () => {
  function pgError(): Error {
    return Object.assign(
      new Error(`duplicate key value violates unique constraint "user_email_uq"`),
      {
        name: 'PostgresError',
        code: '23505',
        severity: 'ERROR',
        constraint_name: 'user_email_uq',
        table_name: 'user',
        schema_name: 'auth',
        routine: '_bt_check_unique',
        detail: `Key (email)=(${EMAIL}) already exists.`,
      },
    );
  }

  it('logs a DrizzleQueryError without SQL, parameter values, PostgreSQL detail or message', () => {
    const error = new DrizzleQueryError(
      'INSERT INTO auth.user (email, token) VALUES ($1, $2)',
      [EMAIL, TOKEN],
      pgError(),
    );
    expect(error.message).toContain(EMAIL); // the premise: drizzle puts the values in the message
    const serialized = serializeErr(error);
    const text = JSON.stringify(serialized);
    for (const secret of [EMAIL, TOKEN, 'INSERT INTO', 'alice', 'already exists']) {
      expect(text).not.toContain(secret);
    }
    expect(serialized).toMatchObject({
      type: 'Error',
      message: 'database query failed',
      db: {
        code: '23505',
        constraint_name: 'user_email_uq',
        table_name: 'user',
        schema_name: 'auth',
        severity: 'ERROR',
        routine: '_bt_check_unique',
      },
    });
  });

  it('strips the message line from the stack of a database error', () => {
    const error = new DrizzleQueryError('SELECT $1', [TOKEN], pgError());
    const stack = String(serializeErr(error).stack);
    expect(stack).not.toContain(TOKEN);
    expect(stack).toMatch(/\n\s+at /);
  });

  it('handles a bare PostgreSQL error (no drizzle wrapper) and never prints its detail', () => {
    const serialized = serializeErr(pgError());
    expect(JSON.stringify(serialized)).not.toContain(EMAIL);
    expect(serialized).toMatchObject({ db: { code: '23505' } });
  });

  it('keeps ordinary errors readable', () => {
    expect(serializeErr(new TypeError('bad input'))).toMatchObject({
      type: 'TypeError',
      message: 'bad input',
    });
  });

  it('returns a copy without SQL, parameters or detail, keeping the SQLSTATE and stack frames', () => {
    const error = new DrizzleQueryError('INSERT INTO t VALUES ($1)', [TOKEN, EMAIL], pgError());
    const clean = sanitizeDatabaseError(error);
    expect(clean?.code).toBe('23505');
    expect(clean?.cause).toBeUndefined();
    const text = JSON.stringify([clean?.message, clean?.stack, clean?.name]);
    for (const secret of [EMAIL, TOKEN, 'INSERT INTO', 'already exists']) {
      expect(text).not.toContain(secret);
    }
    expect(clean?.stack).toMatch(/\n\s+at /);
  });

  it('leaves non-database errors alone', () => {
    expect(sanitizeDatabaseError(new TypeError('bad'))).toBeUndefined();
    expect(sanitizeDatabaseError('text')).toBeUndefined();
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
