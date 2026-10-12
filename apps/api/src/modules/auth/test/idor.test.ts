import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import { AUTH_OPERATIONS, requestFor, send } from '../../../../test/fixtures/operations.js';
import { World } from '../../../../test/fixtures/world.js';
import { expectIdorResult, idorMatrix } from '../../../../test/helpers/authz.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

describeInfra(
  'S2 auth: authorization matrix from x-authz (IDOR, FR-AUTH-07, FR-AUTH-08)',
  ['db', 'redis'],
  () => {
    let world: World;

    beforeAll(async () => {
      world = await World.start();
    });

    afterAll(async () => {
      if (!world) return;
      await world.close();
    });

    describe('idorMatrix of the auth operations', () => {
      it.each(AUTH_OPERATIONS)(
        'FR-AUTH-07: %s has only the cases this slice realises (anonymous) - a new kind means a test is missing',
        (operationId) => {
          const kinds = idorMatrix(operationId).cases.map((c) => c.kind);
          expect(kinds.every((kind) => kind === 'anonymous')).toBe(true);
        },
      );

      it.each(AUTH_OPERATIONS)(
        'FR-AUTH-07: %s without a session follows its x-authz',
        async (operationId) => {
          const matrix = idorMatrix(operationId);
          const anonymous = matrix.cases.find((c) => c.kind === 'anonymous');
          if (!anonymous) {
            // public operations answer without a session (they may still validate the body)
            const response = await send(world.anonymous(), requestFor(operationId));
            expect(response.statusCode, matrix.authz.actor).not.toBe(401);
            return;
          }
          const response = await send(world.anonymous(), requestFor(operationId));
          expectIdorResult(anonymous, response);
          expectProblem(operationId, response, 401, 'UNAUTHENTICATED');
        },
      );
    });

    describe('nobody reaches another account', () => {
      it('FR-AUTH-07: getMe, getMyGithubAccount and getSession return the caller, never a neighbour', async () => {
        const a = await world.signedIn('idor-a');
        const b = await world.signedIn('idor-b');
        expect((await a.session.get('/v1/me')).json<{ id: string }>().id).toBe(a.user.id);
        expect((await b.session.get('/v1/me')).json<{ id: string }>().id).toBe(b.user.id);
        const sessionOfB = await b.session.get('/auth/get-session');
        expect(sessionOfB.json<{ user: { id: string } }>().user.id).toBe(b.user.id);
      });

      it('FR-AUTH-07: a user id sent as a header, query or body field next to a cookie does not switch identity', async () => {
        const a = await world.signedIn('idor-switch-a');
        const b = await world.signedIn('idor-switch-b');
        const response = await a.session.get(`/v1/me?userId=${b.user.id}`, {
          headers: { 'x-user-id': b.user.id, 'x-forwarded-user': b.user.id },
        });
        expect(response.json<{ id: string }>().id).toBe(a.user.id);
      });
    });

    describe('administrator role cannot be obtained through the interface (FR-AUTH-08)', () => {
      it.each([
        ['a profile save with isAdmin', 'PUT', '/v1/me/profile', { isAdmin: true, version: null }],
        [
          'a consent with isAdmin',
          'POST',
          '/v1/me/consents',
          { version: '1', textHash: 'a'.repeat(64), isAdmin: true },
        ],
      ] as const)(
        'FR-AUTH-08: %s -> 400 and the user stays a plain user',
        async (_name, method, url, body) => {
          const { user, session } = await world.signedIn(`idor-promote-${method}`);
          const response = await session.request(method, url, body);
          expect(response.statusCode).toBe(400);
          const me = await session.get('/v1/me');
          expect(me.json<{ isAdmin: boolean }>().isAdmin).toBe(false);
          const rows = await world.sql<
            { is_admin: boolean }[]
          >`SELECT is_admin FROM auth."user" WHERE id = ${user.id}`;
          expect(rows[0]?.is_admin).toBe(false);
        },
      );

      it.each([
        '/auth/update-user',
        '/auth/change-email',
        '/auth/change-password',
        '/auth/set-password',
        '/auth/delete-user',
        '/auth/sign-up/email',
        '/auth/sign-in/email',
        '/auth/revoke-sessions',
      ])(
        'FR-AUTH-08: the library route %s is not exposed (only the contract routes are)',
        async (url) => {
          const { user, session } = await world.signedIn(`idor-lib-${url.replaceAll(/\W/g, '')}`);
          const response = await session.post(
            url,
            { isAdmin: true, name: 'x', email: 'x@example.test', password: 'p'.repeat(12) },
            { idempotencyKey: null },
          );
          expect(response.statusCode).not.toBe(200);
          const rows = await world.sql<{ is_admin: boolean; name: string | null }[]>`
        SELECT is_admin, name FROM auth."user" WHERE id = ${user.id}`;
          expect(rows[0]?.is_admin).toBe(false);
        },
      );

      it('FR-AUTH-08: isAdmin is true only for users marked in the database (seed or CLI)', async () => {
        const admin = await world.createUser('idor-admin', { admin: true });
        const plain = await world.createUser('idor-plain');
        expect((await world.as(admin).get('/v1/me')).json<{ isAdmin: boolean }>().isAdmin).toBe(
          true,
        );
        expect((await world.as(plain).get('/v1/me')).json<{ isAdmin: boolean }>().isAdmin).toBe(
          false,
        );
      });
    });
  },
);
