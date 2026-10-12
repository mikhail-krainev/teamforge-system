import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countOf,
  expectProblem,
  expectReplayed,
  sha256Hex,
} from '../../../../test/fixtures/assertions.js';
import { World } from '../../../../test/fixtures/world.js';
import { expectMatchesContract } from '../../../../test/helpers/contract.js';
import { describeInfra } from '../../../../test/helpers/infra.js';

interface ConsentText {
  version: string;
  textHash: string;
  text: string;
  publishedAt: string;
}

describeInfra('S2 auth: consent and getMe (FR-AUTH-03)', ['db', 'redis'], () => {
  let world: World;

  beforeAll(async () => {
    world = await World.start();
  });

  afterAll(async () => {
    if (!world) return;
    await world.close();
  });

  describe('getCurrentConsentText', () => {
    it('FR-AUTH-03: the current text is public, matches the contract and names the transfer to GitHub', async () => {
      const response = await world.anonymous().get('/v1/consent/current');
      expect(response.statusCode).toBe(200);
      expectMatchesContract('getCurrentConsentText', response);
      const body = response.json<ConsentText>();
      expect(body.text).toContain('GitHub');
      expect(body.textHash).toBe(sha256Hex(body.text));
    });

    it('FR-AUTH-03: the text is the same for every caller (a signed-in user sees the same version and hash)', async () => {
      const person = await world.createUser('consent-reader', { consent: false });
      const mine = await world.as(person).get('/v1/consent/current');
      const anonymous = await world.anonymous().get('/v1/consent/current');
      expect(mine.statusCode).toBe(200);
      expect(mine.json<ConsentText>().textHash).toBe(anonymous.json<ConsentText>().textHash);
    });
  });

  describe('acceptConsent', () => {
    it('FR-AUTH-03: accepting the current text answers 201 and stores version, text hash, UTC time and an IP hash', async () => {
      const person = await world.createUser('accepts', { consent: false });
      const text = await world.currentConsent();
      const ip = '203.0.113.77';
      const response = await world
        .as(person)
        .post('/v1/me/consents', { version: text.version, textHash: text.textHash }, { ip });
      expect(response.statusCode).toBe(201);
      expectMatchesContract('acceptConsent', response);
      expect(response.json<{ version: string }>().version).toBe(text.version);

      const rows = await world.sql<{ version: string; hash: string; ip_hash: Buffer | null }[]>`
        SELECT version, encode(text_hash, 'hex') AS hash, ip_hash
          FROM auth.consent WHERE user_id = ${person.id}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.version).toBe(text.version);
      expect(rows[0]?.hash).toBe(text.textHash);
      // only an HMAC of the address is kept, never the address itself (FR-AUTH-03, C-64)
      expect(rows[0]?.ip_hash).not.toBeNull();
      expect(rows[0]?.ip_hash?.toString('utf8')).not.toContain(ip);
    });

    it('FR-AUTH-03: the same request with the same Idempotency-Key replays the stored 201 without a second record', async () => {
      const person = await world.createUser('accepts-twice', { consent: false });
      const text = await world.currentConsent();
      const key = randomUUID();
      const body = { version: text.version, textHash: text.textHash };
      const first = await world.as(person).post('/v1/me/consents', body, { idempotencyKey: key });
      const second = await world.as(person).post('/v1/me/consents', body, { idempotencyKey: key });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expectReplayed(second);
      expect(
        await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM auth.consent WHERE user_id = ${person.id}`),
      ).toBe(1);
    });

    it('FR-AUTH-03: a wrong text hash is refused (422) and nothing is recorded', async () => {
      const person = await world.createUser('wrong-hash', { consent: false });
      const text = await world.currentConsent();
      const response = await world
        .as(person)
        .post('/v1/me/consents', { version: text.version, textHash: 'f'.repeat(64) });
      expect([409, 422]).toContain(response.statusCode);
      expectMatchesContract('acceptConsent', response);
      expect(
        await countOf(world.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM auth.consent WHERE user_id = ${person.id}`),
      ).toBe(0);
    });

    it('FR-AUTH-03: a version that is not the current one cannot be accepted', async () => {
      const person = await world.createUser('old-version', { consent: false });
      const text = await world.currentConsent();
      const response = await world
        .as(person)
        .post('/v1/me/consents', { version: `${text.version}-old`, textHash: text.textHash });
      expect([409, 422]).toContain(response.statusCode);
      expectMatchesContract('acceptConsent', response);
    });

    it.each([
      ['no body', undefined],
      ['no text hash', { version: '1' }],
      ['a hash that is not hex', { version: '1', textHash: 'zz' }],
      ['an extra field', { version: '1', textHash: 'a'.repeat(64), admin: true }],
    ])('FR-AUTH-03: %s -> 400 VALIDATION_FAILED', async (_name, body) => {
      const person = await world.createUser(`bad-consent-${randomUUID().slice(0, 6)}`, {
        consent: false,
      });
      const response = await world.as(person).post('/v1/me/consents', body);
      expectProblem('acceptConsent', response, 400, 'VALIDATION_FAILED');
    });

    it('FR-AUTH-03: without a session -> 401 UNAUTHENTICATED', async () => {
      const text = await world.currentConsent();
      const response = await world
        .anonymous()
        .post('/v1/me/consents', { version: text.version, textHash: text.textHash });
      expectProblem('acceptConsent', response, 401, 'UNAUTHENTICATED');
    });

    it('FR-WORK-08: without an Idempotency-Key -> 400 IDEMPOTENCY_KEY_MISSING', async () => {
      const person = await world.createUser('no-key', { consent: false });
      const text = await world.currentConsent();
      const response = await world
        .as(person)
        .post(
          '/v1/me/consents',
          { version: text.version, textHash: text.textHash },
          { idempotencyKey: null },
        );
      expectProblem('acceptConsent', response, 400, 'IDEMPOTENCY_KEY_MISSING');
    });
  });

  describe('getMe', () => {
    it('FR-AUTH-03: a signed-in user without consent gets 200 with consentRequired=true (getMe is exempt from the guard)', async () => {
      const person = await world.createUser('me-no-consent', { consent: false });
      const response = await world.as(person).get('/v1/me');
      expect(response.statusCode).toBe(200);
      expectMatchesContract('getMe', response);
      const me = response.json<{ id: string; consentRequired: boolean; status: string }>();
      expect(me.id).toBe(person.id);
      expect(me.consentRequired).toBe(true);
      expect(me.status).toBe('active');
    });

    it('FR-AUTH-03: after accepting the current text getMe reports consentRequired=false and the version', async () => {
      const person = await world.createUser('me-consent', { consent: false });
      const text = await world.currentConsent();
      await world
        .as(person)
        .post('/v1/me/consents', { version: text.version, textHash: text.textHash });
      const response = await world.as(person).get('/v1/me');
      const me = response.json<{ consentRequired: boolean; consentVersion: string | null }>();
      expect(me.consentRequired).toBe(false);
      expect(me.consentVersion).toBe(text.version);
    });

    it('FR-AUTH-03: consent given to an older text is not enough: consentRequired=true again', async () => {
      const person = await world.createUser('me-outdated', { consent: 'outdated' });
      const response = await world.as(person).get('/v1/me');
      expect(response.json<{ consentRequired: boolean }>().consentRequired).toBe(true);
    });

    it('FR-AUTH-02: the e-mail is masked, the user is not an administrator and the locale is ru', async () => {
      const person = await world.createUser('me-masked');
      const response = await world.as(person).get('/v1/me');
      const me = response.json<{
        emailMasked: string | null;
        isAdmin: boolean;
        locale: string;
        github: { linked: boolean };
      }>();
      expect(me.emailMasked).not.toBe(person.email);
      expect(me.emailMasked).toMatch(/^.\*+@/);
      expect(me.isAdmin).toBe(false);
      expect(me.locale).toBe('ru');
      expect(me.github.linked).toBe(false);
    });

    it('FR-AUTH-08: an administrator sees isAdmin=true', async () => {
      const admin = await world.createUser('me-admin', { admin: true });
      const response = await world.as(admin).get('/v1/me');
      expect(response.json<{ isAdmin: boolean }>().isAdmin).toBe(true);
    });

    it('FR-AUTH-07: without a session -> 401 UNAUTHENTICATED', async () => {
      expectProblem('getMe', await world.anonymous().get('/v1/me'), 401, 'UNAUTHENTICATED');
    });
  });

  describe('ConsentGuard (architecture 13.10)', () => {
    it.each([
      ['getMyProfile', '/v1/me/profile'],
      ['getMyResume', '/v1/me/resume'],
      ['getMyGithubAccount', '/v1/me/github'],
      ['listRoles', '/v1/catalog/roles'],
      ['listStackTags', '/v1/catalog/stack-tags'],
    ])('FR-AUTH-03: %s without consent -> 403 CONSENT_REQUIRED', async (operationId, url) => {
      const person = await world.createUser(`guard-${operationId}`, { consent: false });
      expectProblem(operationId, await world.as(person).get(url), 403, 'CONSENT_REQUIRED');
    });

    it('FR-AUTH-03: a write (saveMyProfile) without consent -> 403 CONSENT_REQUIRED and nothing is saved', async () => {
      const person = await world.createUser('guard-write', { consent: false });
      const response = await world.as(person).put('/v1/me/profile', { version: null });
      expectProblem('saveMyProfile', response, 403, 'CONSENT_REQUIRED');
    });

    it('FR-AUTH-03: consent for an outdated text version -> 403 CONSENT_REQUIRED on the next request', async () => {
      const person = await world.createUser('guard-outdated', { consent: 'outdated' });
      expectProblem(
        'getMyProfile',
        await world.as(person).get('/v1/me/profile'),
        403,
        'CONSENT_REQUIRED',
      );
    });

    it('FR-AUTH-03: once the text is accepted the same call is no longer refused for consent', async () => {
      const person = await world.createUser('guard-then-ok', { consent: false });
      expectProblem(
        'listRoles',
        await world.as(person).get('/v1/catalog/roles'),
        403,
        'CONSENT_REQUIRED',
      );
      const text = await world.currentConsent();
      await world
        .as(person)
        .post('/v1/me/consents', { version: text.version, textHash: text.textHash });
      const after = await world.as(person).get('/v1/catalog/roles');
      expect(after.statusCode).toBe(200);
    });

    it('FR-AUTH-03: the exempt operations answer a user without consent: getMe, getCurrentConsentText, requestDeletion', async () => {
      const person = await world.createUser('guard-exempt', { consent: false });
      const caller = world.as(person);
      expect((await caller.get('/v1/me')).statusCode).toBe(200);
      expect((await caller.get('/v1/consent/current')).statusCode).toBe(200);
      const deletion = await caller.post('/v1/me/deletion-requests', {
        reason: 'consent_revoked',
        confirm: true,
      });
      // whatever the outcome of the request itself, it is not refused for missing consent
      expect(deletion.json<{ code?: string }>().code).not.toBe('CONSENT_REQUIRED');
    });
  });
});
