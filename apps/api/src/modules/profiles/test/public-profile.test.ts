import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/fixtures/assertions.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import {
  insertProfile,
  insertResume,
  PROFILE_ROLES,
  PROFILE_STACK,
} from '../../../../test/fixtures/profiles.js';
import { World } from '../../../../test/fixtures/world.js';
import { expectMatchesContract } from '../../../../test/helpers/contract.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { labelOf } from './support.js';

interface PublicProfile {
  userId: string;
  displayName: string;
  timezone: string;
  hoursPerWeek: number;
  portfolioUrl?: string | null;
  stack: string[];
  rolePrefs: { roleCode: string; level: string }[];
  experience?: { title: string; from: string }[];
  strengths?: string[];
  isDeleted: boolean;
}

/** Keys that must never leave the owner's own profile (FR-PROF-06, SEC-03). */
const HIDDEN_KEYS = [
  'email',
  'emailMasked',
  'weaknesses',
  'version',
  'updatedAt',
  'resume',
  'extractedText',
  'suggestions',
  'keepFile',
  'storageKey',
  'consent',
  'isAdmin',
];

const urlOf = (userId: string): string => `/v1/users/${userId}/profile`;

describeInfra('S2 profiles: public profile (getPublicProfile)', ['db', 'redis'], () => {
  let world: World;

  beforeAll(async () => {
    world = await World.start();
    await world.ensureCatalog(PROFILE_ROLES, PROFILE_STACK);
  });

  afterAll(async () => {
    await world.close();
  });

  const newUser = (
    prefix: string,
    options: Parameters<World['createUser']>[1] = {},
  ): Promise<UserFixture> => world.createUser(labelOf(prefix), options);

  describe('what a colleague sees', () => {
    it("FR-PROF-01: another user's profile -> 200 and matches the contract", async () => {
      const owner = await newUser('pub-owner');
      const viewer = await newUser('pub-viewer');
      await insertProfile(world.sql, owner.id);
      const response = await world.as(viewer).get(urlOf(owner.id));
      expect(response.statusCode, response.body).toBe(200);
      expectMatchesContract('getPublicProfile', response);
    });

    it('FR-PROF-01: the public fields are there: name, timezone, hours, stack, ordered role preferences, strengths, isDeleted=false', async () => {
      const owner = await newUser('pub-fields');
      const viewer = await newUser('pub-fields-viewer');
      await insertProfile(world.sql, owner.id, {
        strengths: ['Быстро учусь', 'Работаю в команде'],
      });
      const profile = (await world.as(viewer).get(urlOf(owner.id))).json<PublicProfile>();
      expect(profile.userId).toBe(owner.id);
      expect(profile.displayName).toBe('Иван Петров');
      expect(profile.timezone).toBe('Europe/Moscow');
      expect(profile.hoursPerWeek).toBe(12);
      expect([...profile.stack].sort()).toEqual([...PROFILE_STACK].sort());
      expect(profile.rolePrefs).toEqual([
        { roleCode: 'backend', level: 'junior' },
        { roleCode: 'frontend', level: 'beginner' },
      ]);
      expect(profile.strengths).toEqual(['Быстро учусь', 'Работаю в команде']);
      expect(profile.portfolioUrl).toBe('https://example.test/ivan');
      expect(profile.isDeleted).toBe(false);
      expect(profile.experience).toHaveLength(1);
      expect(profile.experience?.[0]).toMatchObject({
        title: 'Учебный проект',
        from: '2024-09-01',
      });
    });

    it.each(HIDDEN_KEYS)('FR-PROF-01: the public body has no "%s" key', async (key) => {
      const owner = await newUser('pub-hidden');
      const viewer = await newUser('pub-hidden-viewer');
      await insertProfile(world.sql, owner.id);
      await insertResume(world.sql, owner.id, { status: 'done', keepFile: true });
      const body = (await world.as(viewer).get(urlOf(owner.id))).json<Record<string, unknown>>();
      expect(Object.keys(body)).not.toContain(key);
    });

    it('FR-PROF-01: private values never appear anywhere in the body: weaknesses, e-mail and resume text', async () => {
      const owner = await newUser('pub-secret');
      const viewer = await newUser('pub-secret-viewer');
      const marker = `weak-${randomUUID()}`;
      await insertProfile(world.sql, owner.id, { weaknesses: [marker] });
      await insertResume(world.sql, owner.id, {
        status: 'done',
        extractedText: `resume-${marker}`,
      });
      const response = await world.as(viewer).get(urlOf(owner.id));
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(marker);
      expect(response.body).not.toContain(owner.email);
      expect(response.body.toLowerCase()).not.toContain('@example.test');
    });

    it('FR-PROF-01: HTML in free text is returned verbatim (the UI escapes on output)', async () => {
      const owner = await newUser('pub-html');
      const viewer = await newUser('pub-html-viewer');
      const html = '<img src=x onerror=alert(1)>';
      await insertProfile(world.sql, owner.id, { strengths: [html] });
      const response = await world.as(viewer).get(urlOf(owner.id));
      expect(String(response.headers['content-type'])).toContain('application/json');
      expect(response.json<PublicProfile>().strengths).toEqual([html]);
    });

    it("FR-PROF-01: a viewer who has no profile of their own can still read someone else's", async () => {
      const owner = await newUser('pub-noprofile-owner');
      const viewer = await newUser('pub-noprofile-viewer');
      await insertProfile(world.sql, owner.id);
      expect((await world.as(viewer).get(urlOf(owner.id))).statusCode).toBe(200);
      expectProblem('getMyProfile', await world.as(viewer).get('/v1/me/profile'), 404, 'NOT_FOUND');
    });

    it('FR-PROF-01: the owner can read their own public profile by id', async () => {
      const owner = await newUser('pub-self');
      await insertProfile(world.sql, owner.id);
      const response = await world.as(owner).get(urlOf(owner.id));
      expect(response.statusCode).toBe(200);
      expectMatchesContract('getPublicProfile', response);
      expect(response.json<Record<string, unknown>>()).not.toHaveProperty('weaknesses');
    });

    it('FR-AUTH-08: an administrator sees the same public fields only, nothing more', async () => {
      const owner = await newUser('pub-admin-owner');
      const admin = await newUser('pub-admin', { admin: true });
      const viewer = await newUser('pub-admin-ref');
      await insertProfile(world.sql, owner.id);
      const asAdmin = await world.as(admin).get(urlOf(owner.id));
      const asViewer = await world.as(viewer).get(urlOf(owner.id));
      expect(asAdmin.statusCode).toBe(200);
      expectMatchesContract('getPublicProfile', asAdmin);
      expect(Object.keys(asAdmin.json<object>()).sort()).toEqual(
        Object.keys(asViewer.json<object>()).sort(),
      );
      expect(asAdmin.json<object>()).toEqual(asViewer.json<object>());
    });
  });

  describe('what is not there', () => {
    it('FR-PROF-01: an unknown user id -> 404 NOT_FOUND', async () => {
      const viewer = await newUser('pub-unknown');
      expectProblem(
        'getPublicProfile',
        await world.as(viewer).get(urlOf(randomUUID())),
        404,
        'NOT_FOUND',
      );
    });

    it('FR-PROF-01: a user who has not filled in a profile -> 404 NOT_FOUND', async () => {
      const owner = await newUser('pub-empty-owner');
      const viewer = await newUser('pub-empty-viewer');
      expectProblem(
        'getPublicProfile',
        await world.as(viewer).get(urlOf(owner.id)),
        404,
        'NOT_FOUND',
      );
    });

    it("FR-AUTH-09: a deleted user's profile -> 404 NOT_FOUND even if rows remain", async () => {
      const owner = await newUser('pub-deleted', { status: 'deleted' });
      const viewer = await newUser('pub-deleted-viewer');
      await insertProfile(world.sql, owner.id);
      expectProblem(
        'getPublicProfile',
        await world.as(viewer).get(urlOf(owner.id)),
        404,
        'NOT_FOUND',
      );
    });

    it.each(['not-a-uuid', '12345', 'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz'])(
      'FR-PROF-01: a malformed user id "%s" -> 400 VALIDATION_FAILED',
      async (id) => {
        const viewer = await newUser('pub-bad-id');
        expectProblem(
          'getPublicProfile',
          await world.as(viewer).get(urlOf(id)),
          400,
          'VALIDATION_FAILED',
        );
      },
    );
  });

  describe('who may ask', () => {
    it('FR-PROF-01: without a session -> 401 UNAUTHENTICATED', async () => {
      const owner = await newUser('pub-anon-owner');
      await insertProfile(world.sql, owner.id);
      expectProblem(
        'getPublicProfile',
        await world.anonymous().get(urlOf(owner.id)),
        401,
        'UNAUTHENTICATED',
      );
    });

    it('FR-AUTH-03: a viewer without consent -> 403 CONSENT_REQUIRED', async () => {
      const owner = await newUser('pub-consent-owner');
      const viewer = await newUser('pub-consent-viewer', { consent: false });
      await insertProfile(world.sql, owner.id);
      expectProblem(
        'getPublicProfile',
        await world.as(viewer).get(urlOf(owner.id)),
        403,
        'CONSENT_REQUIRED',
      );
    });

    it('FR-AUTH-03: consent for an outdated text version is not enough -> 403 CONSENT_REQUIRED', async () => {
      const owner = await newUser('pub-old-owner');
      const viewer = await newUser('pub-old-viewer', { consent: 'outdated' });
      await insertProfile(world.sql, owner.id);
      expectProblem(
        'getPublicProfile',
        await world.as(viewer).get(urlOf(owner.id)),
        403,
        'CONSENT_REQUIRED',
      );
    });
  });
});
