import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countOf, expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import { PROFILE_ROLES, PROFILE_STACK, profileInput } from '../../../../test/fixtures/profiles.js';
import { World } from '../../../../test/fixtures/world.js';
import { expectMatchesContract } from '../../../../test/helpers/contract.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import {
  childRows,
  codeOf,
  expectPointer,
  insertCatalogEntry,
  labelOf,
  pointersOf,
  profileEvents,
  setCatalogActive,
  type ProfileDto,
} from './support.js';

const URL = '/v1/me/profile';

describeInfra('S2 profiles: my profile (FR-PROF-01)', ['db', 'redis'], () => {
  let world: World;

  beforeAll(async () => {
    world = await World.start();
    await world.ensureCatalog([...PROFILE_ROLES, 'qa', 'devops', 'mobile', 'pm'], PROFILE_STACK);
  });

  afterAll(async () => {
    await world.close();
  });

  const newUser = (
    prefix = 'prof',
    options: Parameters<World['createUser']>[1] = {},
  ): Promise<UserFixture> => world.createUser(labelOf(prefix), options);

  /** First save of `body` (version null) and the parsed profile. */
  async function firstSave(
    user: UserFixture,
    overrides: Parameters<typeof profileInput>[0] = {},
  ): Promise<ProfileDto> {
    const response = await world.as(user).put(URL, profileInput({ version: null, ...overrides }));
    expect(response.statusCode, response.body).toBe(200);
    return response.json<ProfileDto>();
  }

  describe('getMyProfile', () => {
    it('FR-PROF-01: before the first save there is no profile -> 404 NOT_FOUND', async () => {
      const user = await newUser();
      expectProblem('getMyProfile', await world.as(user).get(URL), 404, 'NOT_FOUND');
    });

    it('FR-PROF-01: the profile is private to its owner: another user has none of their own -> 404', async () => {
      const owner = await newUser('owner');
      const other = await newUser('other');
      await firstSave(owner);
      expectProblem('getMyProfile', await world.as(other).get(URL), 404, 'NOT_FOUND');
    });

    it('FR-PROF-01: without a session -> 401 UNAUTHENTICATED', async () => {
      expectProblem('getMyProfile', await world.anonymous().get(URL), 401, 'UNAUTHENTICATED');
    });
  });

  describe('saveMyProfile: create and update', () => {
    it('FR-PROF-01: the first save (version null) answers 200 with the profile, version 1 and the saved fields', async () => {
      const user = await newUser();
      const body = profileInput({ version: null });
      const response = await world.as(user).put(URL, body);
      expect(response.statusCode).toBe(200);
      expectMatchesContract('saveMyProfile', response);
      const profile = response.json<ProfileDto>();
      expect(profile.version).toBe(1);
      expect(profile.userId).toBe(user.id);
      expect(profile.displayName).toBe(body.displayName);
      expect(profile.timezone).toBe(body.timezone);
      expect(profile.hoursPerWeek).toBe(body.hoursPerWeek);
      expect(profile.portfolioUrl).toBe(body.portfolioUrl);
      expect([...profile.stack].sort()).toEqual([...body.stack].sort());
      expect(profile.rolePrefs).toEqual(body.rolePrefs);
      expect(profile.experience).toHaveLength(1);
      expect(profile.experience[0]).toMatchObject({ title: 'Учебный проект', from: '2024-09-01' });
      expect(profile.experience[0]?.to ?? null).toBeNull();
      expect(profile.strengths).toEqual(body.strengths);
      expect(profile.weaknesses).toEqual(body.weaknesses);
    });

    it('FR-PROF-01: getMyProfile returns exactly what the save answered', async () => {
      const user = await newUser();
      const saved = await firstSave(user);
      const response = await world.as(user).get(URL);
      expect(response.statusCode).toBe(200);
      expectMatchesContract('getMyProfile', response);
      expect(response.json<ProfileDto>()).toEqual(saved);
    });

    it('FR-PROF-01: the order of rolePrefs is the priority: it is kept, and a reorder in one save is accepted', async () => {
      const user = await newUser();
      const first = [
        { roleCode: 'pm', level: 'middle' },
        { roleCode: 'backend', level: 'junior' },
        { roleCode: 'frontend', level: 'beginner' },
      ] as const;
      const saved = await firstSave(user, { rolePrefs: [...first] });
      expect(saved.rolePrefs.map((r) => r.roleCode)).toEqual(['pm', 'backend', 'frontend']);
      expect(
        (await world.as(user).get(URL)).json<ProfileDto>().rolePrefs.map((r) => r.roleCode),
      ).toEqual(['pm', 'backend', 'frontend']);

      const reordered = [first[2], first[0], first[1]];
      const response = await world
        .as(user)
        .put(URL, profileInput({ rolePrefs: [...reordered], version: 1 }));
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<ProfileDto>().rolePrefs).toEqual(reordered);
      const rows = await childRows(world.sql, user.id);
      expect(rows.roles.map((r) => r.role_code)).toEqual(['frontend', 'pm', 'backend']);
      expect(new Set(rows.roles.map((r) => r.ordinal)).size).toBe(3);
    });

    it('FR-PROF-01: an update with the current version answers 200 and raises the version by one', async () => {
      const user = await newUser();
      await firstSave(user);
      const response = await world
        .as(user)
        .put(URL, profileInput({ displayName: 'Пётр Иванов', version: 1 }));
      expect(response.statusCode, response.body).toBe(200);
      expectMatchesContract('saveMyProfile', response);
      const profile = response.json<ProfileDto>();
      expect(profile.version).toBe(2);
      expect(profile.displayName).toBe('Пётр Иванов');
      expect((await world.as(user).get(URL)).json<ProfileDto>().displayName).toBe('Пётр Иванов');
    });

    it('FR-PROF-01: every successful update moves the version up by one (1 -> 2 -> 3)', async () => {
      const user = await newUser();
      await firstSave(user);
      for (const version of [1, 2]) {
        const response = await world
          .as(user)
          .put(URL, profileInput({ hoursPerWeek: 10 + version, version }));
        expect(response.json<ProfileDto>().version).toBe(version + 1);
      }
      const rows = await childRows(world.sql, user.id);
      expect(rows.profile[0]?.version).toBe(3);
    });

    it('FR-PROF-01: a stale version -> 409 VERSION_CONFLICT with the current profile, nothing is overwritten', async () => {
      const user = await newUser();
      await firstSave(user);
      await world.as(user).put(URL, profileInput({ displayName: 'Новое имя', version: 1 }));
      const response = await world
        .as(user)
        .put(URL, profileInput({ displayName: 'Устаревшее имя', version: 1 }));
      const problem = expectProblem('saveMyProfile', response, 409, 'VERSION_CONFLICT');
      expect(problem.current).toBeDefined();
      expect(problem.current).toMatchObject({ version: 2, displayName: 'Новое имя' });
      const stored = (await world.as(user).get(URL)).json<ProfileDto>();
      expect(stored.displayName).toBe('Новое имя');
      expect(stored.version).toBe(2);
    });

    it('FR-PROF-01: a first save (version null) when a profile already exists -> 409 VERSION_CONFLICT', async () => {
      const user = await newUser();
      await firstSave(user);
      const response = await world
        .as(user)
        .put(URL, profileInput({ displayName: 'Двойник', version: null }));
      expectProblem('saveMyProfile', response, 409, 'VERSION_CONFLICT');
      expect((await world.as(user).get(URL)).json<ProfileDto>().displayName).toBe('Иван Петров');
    });

    it('FR-PROF-01: the "version" field is required: a body without it -> 400', async () => {
      const user = await newUser();
      const withoutVersion: Record<string, unknown> = { ...profileInput() };
      delete withoutVersion.version;
      const response = await world.as(user).put(URL, withoutVersion);
      expect(response.statusCode, response.body).toBe(400);
      expectMatchesContract('saveMyProfile', response);
      expect(['VERSION_MISSING', 'VALIDATION_FAILED']).toContain(
        response.json<{ code: string }>().code,
      );
      expectProblem('getMyProfile', await world.as(user).get(URL), 404, 'NOT_FOUND');
    });

    it('FR-PROF-01: the smallest valid profile (limits from below, empty lists, no portfolio) is saved', async () => {
      const user = await newUser();
      const saved = await firstSave(user, {
        displayName: 'Ян',
        hoursPerWeek: 3,
        portfolioUrl: null,
        stack: [],
        rolePrefs: [],
        experience: [],
        strengths: [],
        weaknesses: [],
      });
      expect(saved).toMatchObject({
        displayName: 'Ян',
        hoursPerWeek: 3,
        stack: [],
        rolePrefs: [],
        experience: [],
      });
      expect(saved.portfolioUrl ?? null).toBeNull();
    });

    it('FR-PROF-01: the largest valid profile (limits from above: 60, 40, 30 tags, 5 roles, 10 entries, 10 x 200) is saved', async () => {
      const user = await newUser();
      const tags = Array.from({ length: 30 }, (_, i) => `lim${i}_${user.id.slice(0, 6)}`);
      await world.ensureCatalog([], tags);
      const saved = await firstSave(user, {
        displayName: 'Я'.repeat(60),
        hoursPerWeek: 40,
        stack: tags,
        rolePrefs: ['pm', 'backend', 'frontend', 'qa', 'devops'].map((roleCode) => ({
          roleCode,
          level: 'middle' as const,
        })),
        experience: Array.from({ length: 10 }, (_, i) => ({
          title: `Проект ${i}`,
          from: '2020-01-01',
          to: '2021-01-01',
        })),
        strengths: Array.from({ length: 10 }, () => 'с'.repeat(200)),
        weaknesses: Array.from({ length: 10 }, () => 'w'.repeat(200)),
      });
      expect(saved.stack).toHaveLength(30);
      expect(saved.rolePrefs).toHaveLength(5);
      expect(saved.experience).toHaveLength(10);
      expect(saved.strengths).toHaveLength(10);
    });

    it('FR-PROF-01: HTML in free text is stored and returned verbatim (escaping happens on output in the UI)', async () => {
      const user = await newUser();
      const html = '<script>alert(1)</script> & "quote" <b>bold</b>';
      const saved = await firstSave(user, {
        displayName: '<b>Иван</b>',
        strengths: [html],
        weaknesses: [html],
      });
      expect(saved.strengths).toEqual([html]);
      expect(saved.displayName).toBe('<b>Иван</b>');
      const fetched = await world.as(user).get(URL);
      expect(String(fetched.headers['content-type'])).toContain('application/json');
      expect(fetched.json<ProfileDto>().strengths).toEqual([html]);
      const rows = await childRows(world.sql, user.id);
      expect(rows.profile[0]?.strengths).toEqual([html]);
    });

    it('FR-PROF-01: a second save that drops roles, tags and entries leaves no stale child rows', async () => {
      const user = await newUser();
      await firstSave(user, {
        rolePrefs: [
          { roleCode: 'pm', level: 'middle' },
          { roleCode: 'backend', level: 'junior' },
          { roleCode: 'frontend', level: 'beginner' },
        ],
        experience: [
          { title: 'Первый', from: '2022-01-01', to: '2022-06-01' },
          { title: 'Второй', from: '2023-01-01', to: null },
        ],
      });
      const second = profileInput({
        displayName: 'Только одно',
        stack: ['react'],
        rolePrefs: [{ roleCode: 'frontend', level: 'middle' }],
        experience: [{ title: 'Единственный', from: '2024-02-02' }],
        strengths: [],
        weaknesses: ['мало'],
        version: 1,
      });
      const response = await world.as(user).put(URL, second);
      expect(response.statusCode, response.body).toBe(200);
      const rows = await childRows(world.sql, user.id);
      expect(rows.profile).toHaveLength(1);
      expect(rows.profile[0]?.display_name).toBe('Только одно');
      expect(rows.stack).toEqual(['react']);
      expect(rows.roles.map((r) => [r.role_code, r.level])).toEqual([['frontend', 'middle']]);
      expect(rows.experience.map((e) => e.title)).toEqual(['Единственный']);
      expect(rows.profile[0]?.strengths).toEqual([]);
      expect(rows.profile[0]?.weaknesses).toEqual(['мало']);
    });
  });

  describe('saveMyProfile: schema validation (400)', () => {
    const tags = (n: number): string[] => Array.from({ length: n }, (_, i) => `tg${i}`);
    const roles = ['pm', 'backend', 'frontend', 'qa', 'devops', 'mobile'];
    const cases: [string, Record<string, unknown>, string | null][] = [
      ['displayName of 1 character', { displayName: 'я' }, '/displayName'],
      ['displayName of 61 characters', { displayName: 'я'.repeat(61) }, '/displayName'],
      ['hoursPerWeek 2', { hoursPerWeek: 2 }, '/hoursPerWeek'],
      ['hoursPerWeek 41', { hoursPerWeek: 41 }, '/hoursPerWeek'],
      ['hoursPerWeek 12.5', { hoursPerWeek: 12.5 }, '/hoursPerWeek'],
      ['hoursPerWeek as a string', { hoursPerWeek: '12' }, '/hoursPerWeek'],
      ['31 stack tags', { stack: tags(31) }, '/stack'],
      ['a duplicated stack tag', { stack: ['typescript', 'typescript'] }, '/stack'],
      ['a stack tag with capital letters', { stack: ['TypeScript'] }, '/stack/0'],
      [
        '6 role preferences',
        { rolePrefs: roles.map((roleCode) => ({ roleCode, level: 'junior' })) },
        '/rolePrefs',
      ],
      [
        'an unknown level',
        { rolePrefs: [{ roleCode: 'backend', level: 'senior' }] },
        '/rolePrefs/0/level',
      ],
      [
        'a role code with capitals',
        { rolePrefs: [{ roleCode: 'Backend', level: 'junior' }] },
        '/rolePrefs/0/roleCode',
      ],
      [
        '11 experience entries',
        { experience: Array.from({ length: 11 }, () => ({ title: 'x', from: '2020-01-01' })) },
        '/experience',
      ],
      [
        'an experience entry without title',
        { experience: [{ title: '', from: '2020-01-01' }] },
        '/experience/0/title',
      ],
      [
        'an experience date that is not a date',
        { experience: [{ title: 'x', from: '2024-13-45' }] },
        '/experience/0/from',
      ],
      ['11 strengths', { strengths: Array.from({ length: 11 }, () => 'x') }, '/strengths'],
      ['a strength of 201 characters', { strengths: ['x'.repeat(201)] }, '/strengths/0'],
      ['an empty strength', { strengths: [''] }, '/strengths/0'],
      ['11 weaknesses', { weaknesses: Array.from({ length: 11 }, () => 'x') }, '/weaknesses'],
      ['a weakness of 201 characters', { weaknesses: ['x'.repeat(201)] }, '/weaknesses/0'],
      ['a portfolio link over http', { portfolioUrl: 'http://example.test/ivan' }, '/portfolioUrl'],
      ['a javascript: portfolio link', { portfolioUrl: 'javascript:alert(1)' }, '/portfolioUrl'],
      ['a version below 1', { version: 0 }, '/version'],
      ['an extra property', { isAdmin: true }, null],
    ];

    it.each(cases)(
      'FR-PROF-01: %s -> 400 VALIDATION_FAILED and nothing is saved',
      async (_name, patch, pointer) => {
        const user = await newUser('bad');
        const response = await world.as(user).put(URL, { ...profileInput(), ...patch });
        const problem = expectProblem('saveMyProfile', response, 400, 'VALIDATION_FAILED');
        if (pointer) expectPointer(problem, pointer);
        expect(
          await countOf(world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM profiles.profile WHERE user_id = ${user.id}`),
        ).toBe(0);
      },
    );

    it.each([
      'displayName',
      'timezone',
      'hoursPerWeek',
      'stack',
      'rolePrefs',
      'experience',
      'strengths',
      'weaknesses',
    ])(
      'FR-PROF-01: a body without the required field %s -> 400 VALIDATION_FAILED',
      async (field) => {
        const user = await newUser('missing');
        const body: Record<string, unknown> = { ...profileInput() };
        delete body[field];
        expectProblem(
          'saveMyProfile',
          await world.as(user).put(URL, body),
          400,
          'VALIDATION_FAILED',
        );
      },
    );

    it('FR-PROF-01: a request without a body -> 400 VALIDATION_FAILED', async () => {
      const user = await newUser('nobody');
      expectProblem(
        'saveMyProfile',
        await world.as(user).put(URL, undefined),
        400,
        'VALIDATION_FAILED',
      );
    });
  });

  describe('saveMyProfile: domain rules (422)', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      [
        'an unknown stack tag points at its index',
        { stack: ['typescript', 'no_such_tag_zz'] },
        '/stack/1',
      ],
      [
        'an unknown role code',
        { rolePrefs: [{ roleCode: 'no_such_role_zz', level: 'junior' }] },
        '/rolePrefs/0',
      ],
      [
        'the same role twice in rolePrefs',
        {
          rolePrefs: [
            { roleCode: 'backend', level: 'junior' },
            { roleCode: 'backend', level: 'middle' },
          ],
        },
        '/rolePrefs/1',
      ],
      ['a timezone that is not an IANA name', { timezone: 'Mars/Olympus' }, '/timezone'],
      ['a timezone with a city that does not exist', { timezone: 'Europe/Atlantis' }, '/timezone'],
      [
        'an experience period that ends before it starts',
        { experience: [{ title: 'Обратный порядок', from: '2024-05-01', to: '2023-05-01' }] },
        '/experience/0',
      ],
    ];

    it.each(cases)(
      'FR-PROF-01: %s -> 422 with the field pointer, nothing is saved',
      async (_name, patch, pointer) => {
        const user = await newUser('rule');
        const response = await world.as(user).put(URL, { ...profileInput(), ...patch });
        const problem = expectProblem('saveMyProfile', response, 422, 'VALIDATION_FAILED');
        expectPointer(problem, pointer);
        expectProblem('getMyProfile', await world.as(user).get(URL), 404, 'NOT_FOUND');
        expect(await profileEvents(world.sql, user.id)).toHaveLength(0);
      },
    );

    it('FR-PROF-01: every unknown stack tag is reported with its own pointer', async () => {
      const user = await newUser('rule-many');
      const response = await world
        .as(user)
        .put(URL, profileInput({ stack: ['nope_a_zz', 'typescript', 'nope_b_zz'], version: null }));
      const problem = expectProblem('saveMyProfile', response, 422, 'VALIDATION_FAILED');
      expect(pointersOf(problem)).toEqual(expect.arrayContaining(['/stack/0', '/stack/2']));
      expect(pointersOf(problem)).not.toContain('/stack/1');
    });

    it('FR-PROF-01: a failed update keeps the stored profile and its version', async () => {
      const user = await newUser('rule-update');
      await firstSave(user);
      const response = await world
        .as(user)
        .put(URL, profileInput({ stack: ['no_such_tag_zz'], version: 1 }));
      expectProblem('saveMyProfile', response, 422, 'VALIDATION_FAILED');
      const stored = (await world.as(user).get(URL)).json<ProfileDto>();
      expect(stored.version).toBe(1);
      expect([...stored.stack].sort()).toEqual([...PROFILE_STACK].sort());
    });

    it.each([['role'], ['stack tag']] as const)(
      'FR-PROF-09: an inactive %s cannot be newly chosen, but a profile that already has it keeps it',
      async (kind) => {
        const chosen = codeOf('keep');
        const other = codeOf('late');
        await insertCatalogEntry(world.sql, kind, chosen);
        await insertCatalogEntry(world.sql, kind, other, { active: false });
        const pick = (code: string): Parameters<typeof profileInput>[0] =>
          kind === 'role'
            ? { rolePrefs: [{ roleCode: code, level: 'junior' }] }
            : { stack: [code] };
        const pointer = kind === 'role' ? '/rolePrefs/0' : '/stack/0';

        const holder = await newUser('holder');
        const saved = await firstSave(holder, pick(chosen));
        expect(saved.version).toBe(1);
        await setCatalogActive(world.sql, kind, chosen, false);

        // a new user cannot pick the deactivated entry
        const newcomer = await newUser('newcomer');
        const refused = await world
          .as(newcomer)
          .put(URL, profileInput({ ...pick(chosen), version: null }));
        expectPointer(expectProblem('saveMyProfile', refused, 422, 'VALIDATION_FAILED'), pointer);

        // the holder may save again with it (it is not "newly chosen") and still sees it
        const resaved = await world
          .as(holder)
          .put(URL, profileInput({ ...pick(chosen), displayName: 'Тот же выбор', version: 1 }));
        expect(resaved.statusCode, resaved.body).toBe(200);
        const fetched = (await world.as(holder).get(URL)).json<ProfileDto>();
        const codes = kind === 'role' ? fetched.rolePrefs.map((r) => r.roleCode) : fetched.stack;
        expect(codes).toEqual([chosen]);

        // the holder cannot add a different deactivated entry
        const extra = await world.as(holder).put(URL, profileInput({ ...pick(other), version: 2 }));
        expectPointer(expectProblem('saveMyProfile', extra, 422, 'VALIDATION_FAILED'), pointer);
      },
    );
  });

  describe('saveMyProfile: access, idempotency, events', () => {
    it('FR-PROF-01: without a session -> 401 UNAUTHENTICATED', async () => {
      expectProblem(
        'saveMyProfile',
        await world.anonymous().put(URL, profileInput()),
        401,
        'UNAUTHENTICATED',
      );
    });

    it('FR-AUTH-03: without consent -> 403 CONSENT_REQUIRED and nothing is saved', async () => {
      const user = await newUser('noconsent', { consent: false });
      expectProblem(
        'saveMyProfile',
        await world.as(user).put(URL, profileInput()),
        403,
        'CONSENT_REQUIRED',
      );
      expect(
        await countOf(world.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM profiles.profile WHERE user_id = ${user.id}`),
      ).toBe(0);
    });

    it('FR-WORK-08: the same Idempotency-Key and body replays the stored 200; the version is raised once', async () => {
      const user = await newUser('replay');
      await firstSave(user);
      const key = randomUUID();
      const body = profileInput({ displayName: 'Повтор', version: 1 });
      const first = await world.as(user).put(URL, body, { idempotencyKey: key });
      const second = await world.as(user).put(URL, body, { idempotencyKey: key });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expectReplayed(second);
      expectMatchesContract('saveMyProfile', second);
      expect(second.json<ProfileDto>()).toEqual(first.json<ProfileDto>());
      expect(first.json<ProfileDto>().version).toBe(2);
      expect((await childRows(world.sql, user.id)).profile[0]?.version).toBe(2);
      expect(await profileEvents(world.sql, user.id)).toHaveLength(2);
    });

    it('FR-WORK-08: the same Idempotency-Key with another body -> 422 IDEMPOTENCY_KEY_REUSED, nothing changes', async () => {
      const user = await newUser('reused');
      const key = randomUUID();
      const first = await world
        .as(user)
        .put(URL, profileInput({ version: null }), { idempotencyKey: key });
      expect(first.statusCode).toBe(200);
      const second = await world
        .as(user)
        .put(URL, profileInput({ displayName: 'Другое тело', version: 1 }), {
          idempotencyKey: key,
        });
      expectProblem('saveMyProfile', second, 422, 'IDEMPOTENCY_KEY_REUSED');
      const rows = await childRows(world.sql, user.id);
      expect(rows.profile[0]?.version).toBe(1);
      expect(rows.profile[0]?.display_name).toBe('Иван Петров');
    });

    it('FR-WORK-08: a key of one user does not replay for another user', async () => {
      const a = await newUser('key-a');
      const b = await newUser('key-b');
      const key = randomUUID();
      const body = profileInput({ version: null });
      expect((await world.as(a).put(URL, body, { idempotencyKey: key })).statusCode).toBe(200);
      const other = await world.as(b).put(URL, body, { idempotencyKey: key });
      expect(other.statusCode).toBe(200);
      expect(other.headers['idempotent-replayed']).toBeUndefined();
      expect(other.json<ProfileDto>().userId).toBe(b.id);
    });

    it('FR-WORK-08: without an Idempotency-Key -> 400 IDEMPOTENCY_KEY_MISSING', async () => {
      const user = await newUser('nokey');
      const response = await world.as(user).put(URL, profileInput(), { idempotencyKey: null });
      expectProblem('saveMyProfile', response, 400, 'IDEMPOTENCY_KEY_MISSING');
    });

    it('FR-PROF-01: each save writes a profiles.profile_updated event to the outbox in the same transaction', async () => {
      const user = await newUser('outbox');
      expect(await profileEvents(world.sql, user.id)).toHaveLength(0);
      await firstSave(user);
      expect(await profileEvents(world.sql, user.id)).toHaveLength(1);
      await world.as(user).put(URL, profileInput({ hoursPerWeek: 20, version: 1 }));
      expect(await profileEvents(world.sql, user.id)).toHaveLength(2);
      // a refused save (stale version) leaves no event behind
      await world.as(user).put(URL, profileInput({ hoursPerWeek: 21, version: 1 }));
      expect(await profileEvents(world.sql, user.id)).toHaveLength(2);
    });

    it("FR-PROF-01: a profile cannot be written through someone else's id: the body has no userId and the owner is the caller", async () => {
      const victim = await newUser('victim');
      const attacker = await newUser('attacker');
      await firstSave(victim);
      const response = await world
        .as(attacker)
        .put(URL, { ...profileInput({ displayName: 'Захват', version: null }), userId: victim.id });
      // either the extra field is refused or it is ignored; in both cases the victim's profile is untouched
      expect([200, 400]).toContain(response.statusCode);
      const stored = (await world.as(victim).get(URL)).json<ProfileDto>();
      expect(stored.displayName).toBe('Иван Петров');
      expect(stored.version).toBe(1);
      if (response.statusCode === 200) expect(response.json<ProfileDto>().userId).toBe(attacker.id);
    });
  });
});
