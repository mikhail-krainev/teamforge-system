import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, expectReplayed } from '../../../../test/fixtures/assertions.js';
import type { CallOptions, Caller } from '../../../../test/fixtures/clients.js';
import type { UserFixture } from '../../../../test/fixtures/index.js';
import {
  PROFILE_ROLES,
  PROFILE_STACK,
  profileInput,
  type ProfileInputBody,
} from '../../../../test/fixtures/profiles.js';
import { World } from '../../../../test/fixtures/world.js';
import { expectMatchesContract } from '../../../../test/helpers/contract.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import {
  type CatalogEntryDto,
  childRows,
  codeOf,
  expectPointer,
  expectStatus,
  hex,
  insertCatalogEntry,
  labelOf,
  setCatalogActive,
} from './support.js';

interface CatalogPage {
  items: CatalogEntryDto[];
  nextCursor: string | null;
}

interface Kind {
  label: 'role' | 'stack tag';
  listOp: string;
  createOp: string;
  updateOp: string;
  base: string;
  /** The profile fields that choose `code` from this catalog. */
  pick(code: string): Partial<ProfileInputBody>;
  pointer: string;
}

const KINDS: Kind[] = [
  {
    label: 'role',
    listOp: 'listRoles',
    createOp: 'createRole',
    updateOp: 'updateRole',
    base: 'roles',
    pick: (code) => ({ rolePrefs: [{ roleCode: code, level: 'junior' }] }),
    pointer: '/rolePrefs/0',
  },
  {
    label: 'stack tag',
    listOp: 'listStackTags',
    createOp: 'createStackTag',
    updateOp: 'updateStackTag',
    base: 'stack-tags',
    pick: (code) => ({ stack: [code] }),
    pointer: '/stack/0',
  },
];

const TAGS = KINDS[1] as Kind;

const listUrl = (kind: Kind, query = ''): string => `/v1/catalog/${kind.base}${query}`;
const adminUrl = (kind: Kind, code?: string): string =>
  `/v1/admin/catalog/${kind.base}${code ? `/${code}` : ''}`;

describeInfra(
  'S2 profiles: catalogs of roles and stack tags (FR-PROF-09, FR-AUTH-08)',
  ['db', 'redis'],
  () => {
    let world: World;
    let admin: UserFixture;
    let member: UserFixture;

    beforeAll(async () => {
      world = await World.start();
      await world.ensureCatalog(PROFILE_ROLES, PROFILE_STACK);
      admin = await world.createUser(labelOf('cat-admin'), { admin: true });
      member = await world.createUser(labelOf('cat-member'));
    });

    afterAll(async () => {
      await world.close();
    });

    async function rowsOf(kind: Kind, code: string): Promise<CatalogEntryDto[]> {
      const rows =
        kind.label === 'role'
          ? await world.sql<
              CatalogEntryDto[]
            >`SELECT code, name, active FROM profiles.role WHERE code = ${code}`
          : await world.sql<
              CatalogEntryDto[]
            >`SELECT code, name, active FROM profiles.stack_tag WHERE code = ${code}`;
      return [...rows];
    }

    async function listCodes(kind: Kind, query = '', caller = world.as(member)): Promise<string[]> {
      const response = await caller.get(listUrl(kind, query));
      expect(response.statusCode, response.body).toBe(200);
      return response.json<CatalogPage>().items.map((i) => i.code);
    }

    describe('seeded roles', () => {
      it('FR-PROF-09: listRoles answers 200 with the seeded roles: at least 12, all active, pm / frontend / backend among them', async () => {
        const response = await world.as(member).get('/v1/catalog/roles');
        expect(response.statusCode, response.body).toBe(200);
        expectMatchesContract('listRoles', response);
        const { items } = response.json<CatalogPage>();
        expect(items.length).toBeGreaterThanOrEqual(12);
        expect(items.every((i) => i.active)).toBe(true);
        expect(items.every((i) => i.name.length > 0)).toBe(true);
        const codes = items.map((i) => i.code);
        expect(codes).toEqual(expect.arrayContaining(['pm', 'frontend', 'backend']));
        expect(new Set(codes).size).toBe(codes.length);
      });

      it('FR-PROF-09: the seeded roles and stack tags exist in the database (migration seed)', async () => {
        const roles = await world.sql<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM profiles.role WHERE active`;
        const tags = await world.sql<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM profiles.stack_tag WHERE active`;
        expect(roles[0]?.n).toBeGreaterThanOrEqual(12);
        expect(tags[0]?.n).toBeGreaterThanOrEqual(10);
      });
    });

    describe.each(KINDS)('$label catalog', (kind) => {
      const create = (caller: Caller, body: unknown, options: CallOptions = {}) =>
        caller.post(adminUrl(kind), body, options);

      it('FR-PROF-09: an administrator creates an entry -> 201 with code, name and active=true; the row exists', async () => {
        const code = codeOf('mk');
        const response = await create(world.as(admin), { code, name: 'Новая запись' });
        expect(response.statusCode, response.body).toBe(201);
        expectMatchesContract(kind.createOp, response);
        expect(response.json<CatalogEntryDto>()).toEqual({
          code,
          name: 'Новая запись',
          active: true,
        });
        expect(await rowsOf(kind, code)).toEqual([{ code, name: 'Новая запись', active: true }]);
      });

      it('FR-PROF-09: a new entry appears in the list that every signed-in user sees', async () => {
        const code = codeOf('shown');
        await create(world.as(admin), { code, name: 'Видимая' });
        const query = kind.label === 'stack tag' ? `?prefix=${code}` : '';
        const response = await world.as(member).get(listUrl(kind, query));
        expect(response.statusCode).toBe(200);
        expectMatchesContract(kind.listOp, response);
        const found = response.json<CatalogPage>().items.find((i) => i.code === code);
        expect(found).toEqual({ code, name: 'Видимая', active: true });
      });

      it('FR-PROF-09: a new entry is immediately usable in saveMyProfile', async () => {
        const code = codeOf('usable');
        await create(world.as(admin), { code, name: 'Используемая' });
        const user = await world.createUser(labelOf('cat-user'));
        const response = await world
          .as(user)
          .put('/v1/me/profile', profileInput({ ...kind.pick(code), version: null }));
        expect(response.statusCode, response.body).toBe(200);
        const rows = await childRows(world.sql, user.id);
        expect(kind.label === 'role' ? rows.roles.map((r) => r.role_code) : rows.stack).toEqual([
          code,
        ]);
      });

      it('FR-PROF-09: a duplicate code -> 409 and the existing entry is not changed', async () => {
        const code = codeOf('dup');
        await create(world.as(admin), { code, name: 'Первая' });
        const second = await create(world.as(admin), { code, name: 'Вторая' });
        expectStatus(kind.createOp, second, 409);
        expect(await rowsOf(kind, code)).toEqual([{ code, name: 'Первая', active: true }]);
      });

      it.each(['Upper', '1abc', 'a', 'has space', 'x'.repeat(41), 'a/b', 'ünï', ''])(
        'FR-PROF-09: the code "%s" does not match the pattern -> 400 VALIDATION_FAILED, nothing is created',
        async (code) => {
          const response = await create(world.as(admin), { code, name: 'Имя' });
          expectPointer(expectProblem(kind.createOp, response, 400, 'VALIDATION_FAILED'), '/code');
          if (code) expect(await rowsOf(kind, code)).toHaveLength(0);
        },
      );

      it.each([
        ['an empty name', { name: '' }, '/name'],
        ['a name of 81 characters', { name: 'я'.repeat(81) }, '/name'],
        ['no name', { name: undefined }, null],
        ['an extra property', { active: false }, null],
      ] as const)('FR-PROF-09: %s -> 400 VALIDATION_FAILED', async (_name, patch, pointer) => {
        const response = await create(world.as(admin), {
          code: codeOf('inv'),
          name: 'Имя',
          ...patch,
        });
        const problem = expectProblem(kind.createOp, response, 400, 'VALIDATION_FAILED');
        if (pointer) expectPointer(problem, pointer);
      });

      it('FR-PROF-09: a name of 80 characters is accepted', async () => {
        const response = await create(world.as(admin), {
          code: codeOf('long'),
          name: 'я'.repeat(80),
        });
        expect(response.statusCode, response.body).toBe(201);
      });

      it('FR-AUTH-08: an ordinary user cannot create an entry -> 403 ADMIN_ONLY, nothing is created', async () => {
        const code = codeOf('sneak');
        const response = await create(world.as(member), { code, name: 'Чужая' });
        expectProblem(kind.createOp, response, 403, 'ADMIN_ONLY');
        expect(await rowsOf(kind, code)).toHaveLength(0);
      });

      it('FR-AUTH-08: an ordinary user cannot change an entry -> 403 ADMIN_ONLY, the entry stays as it was', async () => {
        const code = codeOf('guarded');
        await insertCatalogEntry(world.sql, kind.label, code, { name: 'Исходная' });
        const response = await world
          .as(member)
          .patch(adminUrl(kind, code), { name: 'Взлом', active: false });
        expectProblem(kind.updateOp, response, 403, 'ADMIN_ONLY');
        expect(await rowsOf(kind, code)).toEqual([{ code, name: 'Исходная', active: true }]);
      });

      it('FR-AUTH-08: the administrator flag is not granted through the profile or the catalog calls', async () => {
        const user = await world.createUser(labelOf('cat-noadmin'));
        await world
          .as(user)
          .put('/v1/me/profile', { ...profileInput({ version: null }), isAdmin: true });
        const stillMember = await create(world.as(user), { code: codeOf('nope'), name: 'Нет' });
        expectProblem(kind.createOp, stillMember, 403, 'ADMIN_ONLY');
      });

      it('FR-AUTH-08: without a session the admin calls and the list answer 401 UNAUTHENTICATED', async () => {
        const code = codeOf('anon');
        await insertCatalogEntry(world.sql, kind.label, code);
        expectProblem(
          kind.createOp,
          await create(world.anonymous(), { code: codeOf('a'), name: 'x' }),
          401,
          'UNAUTHENTICATED',
        );
        expectProblem(
          kind.updateOp,
          await world.anonymous().patch(adminUrl(kind, code), { name: 'x' }),
          401,
          'UNAUTHENTICATED',
        );
        expectProblem(
          kind.listOp,
          await world.anonymous().get(listUrl(kind)),
          401,
          'UNAUTHENTICATED',
        );
      });

      it('FR-AUTH-03: the list without consent -> 403 CONSENT_REQUIRED', async () => {
        const user = await world.createUser(labelOf('cat-noconsent'), { consent: false });
        expectProblem(
          kind.listOp,
          await world.as(user).get(listUrl(kind)),
          403,
          'CONSENT_REQUIRED',
        );
      });

      it('FR-PROF-09: an administrator renames an entry -> 200, only the name changes', async () => {
        const code = codeOf('ren');
        await insertCatalogEntry(world.sql, kind.label, code, { name: 'Старое' });
        const response = await world.as(admin).patch(adminUrl(kind, code), { name: 'Новое имя' });
        expect(response.statusCode, response.body).toBe(200);
        expectMatchesContract(kind.updateOp, response);
        expect(response.json<CatalogEntryDto>()).toEqual({ code, name: 'Новое имя', active: true });
        expect(await rowsOf(kind, code)).toEqual([{ code, name: 'Новое имя', active: true }]);
      });

      it('FR-PROF-09: an update of an unknown code -> 404 NOT_FOUND', async () => {
        const response = await world
          .as(admin)
          .patch(adminUrl(kind, codeOf('ghost')), { name: 'Нет такой' });
        expectProblem(kind.updateOp, response, 404, 'NOT_FOUND');
      });

      it.each([
        ['a malformed code in the path', 'Bad_Code', { name: 'x' }],
        ['an empty name', 'ok_code_x', { name: '' }],
        ['an extra property', 'ok_code_y', { name: 'x', code: 'other' }],
        ['a non-boolean active flag', 'ok_code_z', { active: 'no' }],
      ])('FR-PROF-09: an update with %s -> 400 VALIDATION_FAILED', async (_name, code, body) => {
        const response = await world.as(admin).patch(adminUrl(kind, code), body);
        expectProblem(kind.updateOp, response, 400, 'VALIDATION_FAILED');
      });

      it('FR-PROF-09: a deactivated entry leaves the default list, shows with includeInactive, is refused in new saves, stays on existing profiles', async () => {
        const code = codeOf('off');
        const query = kind.label === 'stack tag' ? `&prefix=${code}` : '';
        await create(world.as(admin), { code, name: 'Отключаемая' });
        const holder = await world.createUser(labelOf('cat-holder'));
        expect(
          (
            await world
              .as(holder)
              .put('/v1/me/profile', profileInput({ ...kind.pick(code), version: null }))
          ).statusCode,
        ).toBe(200);

        const response = await world.as(admin).patch(adminUrl(kind, code), { active: false });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json<CatalogEntryDto>().active).toBe(false);

        expect(
          await listCodes(kind, kind.label === 'stack tag' ? `?prefix=${code}` : ''),
        ).not.toContain(code);
        const all = await world.as(member).get(listUrl(kind, `?includeInactive=true${query}`));
        expect(all.statusCode).toBe(200);
        expectMatchesContract(kind.listOp, all);
        expect(all.json<CatalogPage>().items.find((i) => i.code === code)).toEqual({
          code,
          name: 'Отключаемая',
          active: false,
        });

        const newcomer = await world.createUser(labelOf('cat-newcomer'));
        const refused = await world
          .as(newcomer)
          .put('/v1/me/profile', profileInput({ ...kind.pick(code), version: null }));
        expectPointer(
          expectProblem('saveMyProfile', refused, 422, 'VALIDATION_FAILED'),
          kind.pointer,
        );

        const mine = (await world.as(holder).get('/v1/me/profile')).json<{
          rolePrefs: { roleCode: string }[];
          stack: string[];
        }>();
        expect(kind.label === 'role' ? mine.rolePrefs.map((r) => r.roleCode) : mine.stack).toEqual([
          code,
        ]);
      });

      it('FR-PROF-09: re-activating an entry returns it to the list and to new saves', async () => {
        const code = codeOf('back');
        await insertCatalogEntry(world.sql, kind.label, code, { active: false });
        const response = await world.as(admin).patch(adminUrl(kind, code), { active: true });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json<CatalogEntryDto>().active).toBe(true);
        expect(
          await listCodes(kind, kind.label === 'stack tag' ? `?prefix=${code}` : ''),
        ).toContain(code);
        const user = await world.createUser(labelOf('cat-react'));
        const saved = await world
          .as(user)
          .put('/v1/me/profile', profileInput({ ...kind.pick(code), version: null }));
        expect(saved.statusCode, saved.body).toBe(200);
      });

      it('FR-PROF-09: includeInactive that is not a boolean -> 400 VALIDATION_FAILED', async () => {
        const response = await world.as(member).get(listUrl(kind, '?includeInactive=maybe'));
        expectProblem(kind.listOp, response, 400, 'VALIDATION_FAILED');
      });

      it('FR-PROF-09: includeInactive=false is the same as the default', async () => {
        const code = codeOf('hid');
        await insertCatalogEntry(world.sql, kind.label, code, { active: false });
        const query = kind.label === 'stack tag' ? `&prefix=${code}` : '';
        expect(await listCodes(kind, `?includeInactive=false${query}`)).not.toContain(code);
      });

      it('FR-WORK-08: the same Idempotency-Key replays the stored 201: one entry, the Idempotent-Replayed header', async () => {
        const code = codeOf('idem');
        const key = randomUUID();
        const first = await create(
          world.as(admin),
          { code, name: 'Один раз' },
          { idempotencyKey: key },
        );
        const second = await create(
          world.as(admin),
          { code, name: 'Один раз' },
          { idempotencyKey: key },
        );
        expect(first.statusCode).toBe(201);
        expect(second.statusCode).toBe(201);
        expectReplayed(second);
        expect(second.json<CatalogEntryDto>()).toEqual(first.json<CatalogEntryDto>());
        expect(await rowsOf(kind, code)).toHaveLength(1);
      });

      it('FR-WORK-08: the same Idempotency-Key with another body -> 422 IDEMPOTENCY_KEY_REUSED', async () => {
        const key = randomUUID();
        const first = await create(
          world.as(admin),
          { code: codeOf('k1'), name: 'А' },
          { idempotencyKey: key },
        );
        expect(first.statusCode).toBe(201);
        const second = await create(
          world.as(admin),
          { code: codeOf('k2'), name: 'Б' },
          { idempotencyKey: key },
        );
        expectProblem(kind.createOp, second, 422, 'IDEMPOTENCY_KEY_REUSED');
      });

      it('FR-WORK-08: an update with the same Idempotency-Key replays the stored 200', async () => {
        const code = codeOf('upd');
        await insertCatalogEntry(world.sql, kind.label, code, { name: 'До' });
        const key = randomUUID();
        const first = await world
          .as(admin)
          .patch(adminUrl(kind, code), { name: 'После' }, { idempotencyKey: key });
        const second = await world
          .as(admin)
          .patch(adminUrl(kind, code), { name: 'После' }, { idempotencyKey: key });
        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        expectReplayed(second);
      });

      it('FR-WORK-08: create and update without an Idempotency-Key -> 400 IDEMPOTENCY_KEY_MISSING', async () => {
        const code = codeOf('nokey');
        await insertCatalogEntry(world.sql, kind.label, code);
        const created = await create(
          world.as(admin),
          { code: codeOf('nk'), name: 'x' },
          { idempotencyKey: null },
        );
        expectProblem(kind.createOp, created, 400, 'IDEMPOTENCY_KEY_MISSING');
        const updated = await world
          .as(admin)
          .patch(adminUrl(kind, code), { name: 'x' }, { idempotencyKey: null });
        expectProblem(kind.updateOp, updated, 400, 'IDEMPOTENCY_KEY_MISSING');
      });
    });

    describe('listRoles: inactive roles', () => {
      it('FR-PROF-09: includeInactive=true adds the deactivated roles with active=false', async () => {
        const code = codeOf('role_off');
        await insertCatalogEntry(world.sql, 'role', code, { active: false });
        const normal = await world.as(member).get('/v1/catalog/roles');
        const all = await world.as(member).get('/v1/catalog/roles?includeInactive=true');
        expect(normal.json<CatalogPage>().items.map((i) => i.code)).not.toContain(code);
        expectMatchesContract('listRoles', all);
        expect(all.json<CatalogPage>().items.find((i) => i.code === code)?.active).toBe(false);
      });
    });

    describe('listStackTags: cursor pagination, prefix search', () => {
      const prefix = `pg${hex(6)}`;
      const created = Array.from(
        { length: 25 },
        (_, i) => `${prefix}_${String(i).padStart(2, '0')}`,
      );

      beforeAll(async () => {
        for (const code of created)
          await insertCatalogEntry(world.sql, 'stack tag', code, { name: `Тег ${code}` });
      });

      async function walk(query: string): Promise<{ pages: CatalogPage[]; codes: string[] }> {
        const pages: CatalogPage[] = [];
        let cursor: string | null = null;
        do {
          const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
          const response = await world.as(member).get(listUrl(TAGS, `?${query}${suffix}`));
          expect(response.statusCode, response.body).toBe(200);
          expectMatchesContract('listStackTags', response);
          const page = response.json<CatalogPage>();
          pages.push(page);
          cursor = page.nextCursor;
          expect(pages.length).toBeLessThan(200);
        } while (cursor);
        return { pages, codes: pages.flatMap((p) => p.items.map((i) => i.code)) };
      }

      it('FR-PROF-09: 25 tags with limit=10 come in pages of 10, 10 and 5; the last page has nextCursor null', async () => {
        const { pages, codes } = await walk(`prefix=${prefix}&limit=10`);
        expect(pages.map((p) => p.items.length)).toEqual([10, 10, 5]);
        expect(pages.map((p) => p.nextCursor !== null)).toEqual([true, true, false]);
        expect(new Set(codes).size).toBe(25);
        expect([...codes].sort()).toEqual(created);
      });

      it('FR-PROF-09: the pages are in a stable key order (by code), with no gaps or repeats between pages', async () => {
        const { codes } = await walk(`prefix=${prefix}&limit=7`);
        const ascending = [...codes].sort();
        expect([ascending, [...ascending].reverse()]).toContainEqual(codes);
        expect(codes).toHaveLength(25);
      });

      it('FR-PROF-09: following nextCursor over the whole catalog visits every active tag exactly once', async () => {
        const { codes } = await walk('limit=50');
        const active = await world.sql<
          { code: string }[]
        >`SELECT code FROM profiles.stack_tag WHERE active`;
        expect(new Set(codes).size).toBe(codes.length);
        expect([...codes].sort()).toEqual(active.map((r) => r.code).sort());
      });

      it('FR-PROF-09: without limit the page size is the default 20 (C-40) and more follows', async () => {
        const response = await world.as(member).get(listUrl(TAGS, `?prefix=${prefix}`));
        expect(response.statusCode).toBe(200);
        const page = response.json<CatalogPage>();
        expect(page.items).toHaveLength(20);
        expect(page.nextCursor).not.toBeNull();
      });

      it('FR-PROF-09: limit=1 and limit=100 are the accepted bounds', async () => {
        const one = (
          await world.as(member).get(listUrl(TAGS, `?prefix=${prefix}&limit=1`))
        ).json<CatalogPage>();
        expect(one.items).toHaveLength(1);
        expect(one.nextCursor).not.toBeNull();
        const hundred = await world.as(member).get(listUrl(TAGS, `?prefix=${prefix}&limit=100`));
        expect(hundred.statusCode).toBe(200);
        expect(hundred.json<CatalogPage>().items).toHaveLength(25);
        expect(hundred.json<CatalogPage>().nextCursor).toBeNull();
      });

      it('FR-PROF-09: the prefix filter matches the beginning of the code', async () => {
        const codes = await listCodes(TAGS, `?prefix=${prefix}_1&limit=100`);
        expect([...codes].sort()).toEqual(created.filter((c) => c.startsWith(`${prefix}_1`)));
      });

      it('FR-PROF-09: the prefix filter also matches the beginning of the name', async () => {
        const code = `zc${hex(8)}`;
        const word = `nmword${hex(6)}`;
        await insertCatalogEntry(world.sql, 'stack tag', code, { name: `${word} framework` });
        expect(await listCodes(TAGS, `?prefix=${word}`)).toEqual([code]);
      });

      it('FR-PROF-09: a prefix that matches nothing -> 200 with an empty page and nextCursor null', async () => {
        const response = await world.as(member).get(listUrl(TAGS, `?prefix=zz${hex(8)}`));
        expect(response.statusCode).toBe(200);
        expect(response.json<CatalogPage>()).toEqual({ items: [], nextCursor: null });
      });

      it('FR-PROF-09: deactivated tags are skipped by the pagination unless includeInactive is set', async () => {
        await setCatalogActive(world.sql, 'stack tag', `${prefix}_03`, false);
        const normal = await walk(`prefix=${prefix}&limit=10`);
        expect(normal.codes).toHaveLength(24);
        expect(normal.codes).not.toContain(`${prefix}_03`);
        const all = await walk(`prefix=${prefix}&limit=10&includeInactive=true`);
        expect(all.codes).toHaveLength(25);
        await setCatalogActive(world.sql, 'stack tag', `${prefix}_03`, true);
      });

      it.each(['0', '101', '-1', 'abc', '1.5'])(
        'FR-PROF-09: limit=%s -> 400 VALIDATION_FAILED',
        async (limit) => {
          const response = await world.as(member).get(listUrl(TAGS, `?limit=${limit}`));
          expectProblem('listStackTags', response, 400, 'VALIDATION_FAILED');
        },
      );

      it.each([
        ['an empty prefix', 'prefix='],
        ['a prefix of 33 characters', `prefix=${'a'.repeat(33)}`],
        ['a cursor that is not ours', 'cursor=garbage'],
        ['a cursor longer than 512 characters', `cursor=${'a'.repeat(513)}`],
      ])('FR-PROF-09: %s -> 400 VALIDATION_FAILED', async (_name, query) => {
        const response = await world.as(member).get(listUrl(TAGS, `?${query}`));
        expectProblem('listStackTags', response, 400, 'VALIDATION_FAILED');
      });

      it('FR-PROF-09: a cursor from one filter cannot be replayed with another -> 400 VALIDATION_FAILED', async () => {
        const first = await world.as(member).get(listUrl(TAGS, `?prefix=${prefix}&limit=5`));
        const cursor = first.json<CatalogPage>().nextCursor ?? '';
        expect(cursor).not.toBe('');
        const response = await world
          .as(member)
          .get(listUrl(TAGS, `?prefix=${prefix}_1&limit=5&cursor=${encodeURIComponent(cursor)}`));
        expectProblem('listStackTags', response, 400, 'VALIDATION_FAILED');
      });
    });
  },
);
