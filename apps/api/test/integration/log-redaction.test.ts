import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { call } from '../helpers/http.js';
import { createTestDatabase, describeInfra, type TestDatabase } from '../helpers/infra.js';

describeInfra(
  'S1R-01 database errors never put values into the log (SEC-07)',
  ['db', 'redis'],
  () => {
    let db: TestDatabase;
    let testApp: TestApp;

    beforeAll(async () => {
      db = await createTestDatabase();
      testApp = await createTestApp({ databaseUrl: db.url });
    });

    afterAll(async () => {
      await testApp.close();
      await db.drop();
    });

    it('a failed INSERT (23505) logs the SQLSTATE and constraint, but no email or token', async () => {
      const email = `alice-${randomUUID()}@example.com`;
      const token = `SESSION-TOKEN-${randomUUID()}`;
      const first = await call(testApp.app, 'POST', '/v1/_test/accounts', { email, token });
      expect(first.statusCode).toBe(201);
      const second = await call(testApp.app, 'POST', '/v1/_test/accounts', { email, token });
      expect(second.statusCode).toBe(500);
      expect(second.json()).toMatchObject({ code: 'INTERNAL' });
      expect(JSON.stringify(second.json())).not.toContain(email);

      const failure = testApp.logs.filter((line) => line.includes('Unhandled exception'));
      expect(failure.length).toBeGreaterThan(0);
      const logged = testApp.logs.join('\n');
      expect(logged).not.toContain(email);
      expect(logged).not.toContain(token);
      expect(logged).not.toContain('alice-');
      expect(logged).not.toMatch(/params:/);
      expect(logged).not.toContain('INSERT INTO');
      const entry = JSON.parse(failure[0] ?? '{}') as { err?: { db?: Record<string, string> } };
      expect(entry.err?.db).toMatchObject({
        code: '23505',
        constraint_name: 'tf_test_account_email_uq',
        table_name: 'tf_test_account',
      });
    });
  },
);
