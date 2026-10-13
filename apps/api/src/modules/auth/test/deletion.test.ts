import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  countOf,
  expectProblem,
  expectRateLimited,
  gapMs,
} from '../../../../test/fixtures/assertions.js';
import { randomIp } from '../../../../test/fixtures/clients.js';
import { World } from '../../../../test/fixtures/world.js';
import { expectMatchesContract } from '../../../../test/helpers/contract.js';
import { describeInfra, waitFor } from '../../../../test/helpers/infra.js';
import { cancelTokenOf } from './deletion-helpers.js';

interface DeletionRequestBody {
  id: string;
  status: 'requested' | 'in_progress' | 'completed' | 'cancelled';
  requestedAt: string;
  scheduledAt: string;
  deadlineAt: string;
}

const HOUR = 3_600_000;

describeInfra('S2 auth: account deletion request and cancel (FR-AUTH-09)', ['db', 'redis'], () => {
  let world: World;

  beforeAll(async () => {
    world = await World.start();
  });

  afterAll(async () => {
    if (!world) return;
    await world.close();
  });

  const request = (
    session: Awaited<ReturnType<World['signedIn']>>['session'],
    body: unknown = { reason: 'user_request', confirm: true },
  ) => session.post('/v1/me/deletion-requests', body);

  /** Signs in, requests deletion and returns everything a cancel scenario needs. */
  async function requested(label: string) {
    const { user, session } = await world.signedIn(label);
    const before = await world.mail.countTo(user.email);
    const response = await request(session);
    expect(response.statusCode).toBe(202);
    const mail = await world.mail.latestTo(user.email, { minCount: before + 1 });
    return { user, session, response, token: cancelTokenOf(mail), mail };
  }

  describe('requestDeletion', () => {
    it('FR-AUTH-09: a fresh session gets 202 with a 72-hour grace period and a 30-day deadline', async () => {
      const { user, session } = await world.signedIn('del-ok');
      const response = await request(session);
      expect(response.statusCode).toBe(202);
      expectMatchesContract('requestDeletion', response);
      const body = response.json<DeletionRequestBody>();
      expect(body.status).toBe('requested');
      expect(gapMs(body.requestedAt, body.scheduledAt)).toBe(72 * HOUR);
      expect(gapMs(body.requestedAt, body.deadlineAt)).toBeGreaterThanOrEqual(72 * HOUR);
      expect(gapMs(body.requestedAt, body.deadlineAt)).toBeLessThanOrEqual(30 * 24 * HOUR);
      const rows = await world.sql<{ status: string; user_status: string }[]>`
        SELECT r.status, u.status AS user_status FROM auth.deletion_request r
          JOIN auth."user" u ON u.id = r.user_id WHERE r.user_id = ${user.id}`;
      expect(rows).toEqual([{ status: 'requested', user_status: 'deleting' }]);
    });

    it('FR-AUTH-09 / S2CR-02: the sessions are revoked by the event consumer shortly after the 202 and the old cookie no longer works', async () => {
      const { user, session } = await world.signedIn('del-revoke');
      const other = await world.signIn(user.email);
      await request(session);
      await waitFor(async () => (await session.get('/v1/me')).statusCode === 401);
      await waitFor(async () => (await other.get('/v1/me')).statusCode === 401);
    });

    it('FR-AUTH-09: the confirmation mail carries a one-time cancel link; only a hash of the token is stored', async () => {
      const { token } = await requested('del-mail');
      expect(token.length).toBeGreaterThanOrEqual(32);
      const rows = await world.sql`SELECT * FROM auth.deletion_request`;
      expect(JSON.stringify(rows)).not.toContain(token);
      const stored = await world.sql<{ hash: Buffer }[]>`
        SELECT cancel_token_hash AS hash FROM auth.deletion_request WHERE cancel_token_hash IS NOT NULL`;
      expect(stored.some((r) => r.hash.length === 32)).toBe(true);
      expect(createHash('sha256').update(token).digest().length).toBe(32);
    });

    it('FR-AUTH-09: sign-in is closed for an account that waits for deletion', async () => {
      const { user } = await requested('del-closed');
      const usable = await world
        .signIn(user.email)
        .then((session) => session.get('/v1/me'))
        .then((me) => me.statusCode === 200)
        .catch(() => false);
      expect(usable).toBe(false);
    });

    it('FR-AUTH-09: a session older than 10 minutes must sign in again: 403 REAUTH_REQUIRED, the account stays active', async () => {
      const { user, session } = await world.signedIn('del-stale');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(Date.now() + 11 * 60_000));
      let response;
      try {
        response = await request(session);
      } finally {
        vi.useRealTimers();
      }
      expectProblem('requestDeletion', response, 403, 'REAUTH_REQUIRED');
      const rows = await world.sql<
        { status: string }[]
      >`SELECT status FROM auth."user" WHERE id = ${user.id}`;
      expect(rows[0]?.status).toBe('active');
    });

    it('FR-AUTH-09: a user who has not given consent can still ask for deletion (the guard exempts it)', async () => {
      const { session } = await world.signedIn('del-noconsent', { consent: false });
      const response = await request(session, { reason: 'consent_revoked', confirm: true });
      expect(response.statusCode).toBe(202);
    });

    it('FR-AUTH-09: a double click with two sessions -> one 202, the other 409 DELETION_ALREADY_REQUESTED, one request row', async () => {
      const { user, session } = await world.signedIn('del-double');
      const second = await world.signIn(user.email);
      const results = await Promise.all([request(session), request(second)]);
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([202, 409]);
      const conflict = results.find((r) => r.statusCode === 409);
      if (conflict) expectProblem('requestDeletion', conflict, 409, 'DELETION_ALREADY_REQUESTED');
      expect(
        await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM auth.deletion_request WHERE user_id = ${user.id}`),
      ).toBe(1);
    });

    it.each([
      ['confirm=false', { reason: 'user_request', confirm: false }],
      ['no confirm', { reason: 'user_request' }],
      ['an unknown reason', { reason: 'because', confirm: true }],
      ['an extra field', { reason: 'user_request', confirm: true, now: true }],
      ['an empty body', {}],
    ])('FR-AUTH-09: %s -> 400 and nothing is requested', async (_name, body) => {
      const { user, session } = await world.signedIn(`del-bad-${randomUUID().slice(0, 6)}`);
      const response = await request(session, body);
      expectProblem('requestDeletion', response, 400, 'VALIDATION_FAILED');
      expect(
        await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM auth.deletion_request WHERE user_id = ${user.id}`),
      ).toBe(0);
    });

    it('FR-AUTH-09: without a session -> 401 UNAUTHENTICATED', async () => {
      const response = await world.anonymous().post('/v1/me/deletion-requests', {
        reason: 'user_request',
        confirm: true,
      });
      expectProblem('requestDeletion', response, 401, 'UNAUTHENTICATED');
    });

    it('FR-WORK-08: without an Idempotency-Key -> 400 IDEMPOTENCY_KEY_MISSING', async () => {
      const { session } = await world.signedIn('del-nokey');
      const response = await session.post(
        '/v1/me/deletion-requests',
        { reason: 'user_request', confirm: true },
        { idempotencyKey: null },
      );
      expectProblem('requestDeletion', response, 400, 'IDEMPOTENCY_KEY_MISSING');
    });
  });

  describe('cancelDeletionRequest', () => {
    const cancel = (token: string, ip = randomIp()) =>
      world
        .anonymous()
        .post('/v1/deletion-request-cancellations', { token }, { idempotencyKey: null, ip });

    it('FR-AUTH-09: the token from the mail cancels the request: 200 cancelled, the account is active again', async () => {
      const { user, token } = await requested('cancel-ok');
      const response = await cancel(token);
      expect(response.statusCode).toBe(200);
      expectMatchesContract('cancelDeletionRequest', response);
      expect(response.json<DeletionRequestBody>().status).toBe('cancelled');
      const rows = await world.sql<
        { status: string }[]
      >`SELECT status FROM auth."user" WHERE id = ${user.id}`;
      expect(rows[0]?.status).toBe('active');
      const session = await world.signIn(user.email);
      const me = await session.get('/v1/me');
      expect(me.statusCode).toBe(200);
      expect(me.json<{ status: string }>().status).toBe('active');
    });

    it('FR-AUTH-09: cancelling again with the same token is idempotent (200, same request, still cancelled)', async () => {
      const { token } = await requested('cancel-twice');
      const first = await cancel(token);
      const second = await cancel(token);
      expect(second.statusCode).toBe(200);
      expect(second.json<DeletionRequestBody>().id).toBe(first.json<DeletionRequestBody>().id);
      expect(second.json<DeletionRequestBody>().status).toBe('cancelled');
    });

    it('FR-AUTH-09: after cancelling, a new deletion request is possible', async () => {
      const { user, token } = await requested('cancel-then-again');
      await cancel(token);
      const session = await world.signIn(user.email);
      expect((await request(session)).statusCode).toBe(202);
    });

    it('FR-AUTH-09: a token nobody was given -> 410 DELETION_CANCEL_GONE, nothing changes', async () => {
      const { user } = await requested('cancel-foreign');
      const response = await cancel(
        randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '').slice(0, 11),
      );
      expectProblem('cancelDeletionRequest', response, 410, 'DELETION_CANCEL_GONE');
      const rows = await world.sql<
        { status: string }[]
      >`SELECT status FROM auth."user" WHERE id = ${user.id}`;
      expect(rows[0]?.status).toBe('deleting');
    });

    it('FR-AUTH-09: the token of one user cannot cancel the request of another (each token maps to its own request)', async () => {
      const a = await requested('cancel-a');
      const b = await requested('cancel-b');
      await cancel(a.token);
      const rows = await world.sql<{ status: string }[]>`
        SELECT status FROM auth."user" WHERE id = ${b.user.id}`;
      expect(rows[0]?.status).toBe('deleting');
    });

    it.each([
      ['too short (< 32)', 'A'.repeat(31)],
      ['too long (> 128)', 'A'.repeat(129)],
    ])('FR-AUTH-09: a token that is %s -> 400', async (_name, token) => {
      const response = await cancel(token);
      expect(response.statusCode).toBe(400);
      expectMatchesContract('cancelDeletionRequest', response);
    });

    it('FR-AUTH-09: a body without token or with extra fields -> 400', async () => {
      const anonymous = world.anonymous();
      expect(
        (await anonymous.post('/v1/deletion-request-cancellations', {}, { idempotencyKey: null }))
          .statusCode,
      ).toBe(400);
      const extra = await anonymous.post(
        '/v1/deletion-request-cancellations',
        { token: 'A'.repeat(43), force: true },
        { idempotencyKey: null },
      );
      expect(extra.statusCode).toBe(400);
    });

    it('FR-AUTH-04: cancelling is limited to 10 attempts per hour per IP, then 429 with Retry-After', async () => {
      const ip = randomIp();
      for (let i = 0; i < 10; i += 1) {
        expect((await cancel(`${'B'.repeat(40)}${i}`, ip)).statusCode).toBe(410);
      }
      expectRateLimited('cancelDeletionRequest', await cancel('C'.repeat(43), ip));
    });
  });
});
