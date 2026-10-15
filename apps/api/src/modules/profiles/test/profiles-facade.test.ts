import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertProfile, PROFILE_ROLES, PROFILE_STACK } from '../../../../test/fixtures/profiles.js';
import { World } from '../../../../test/fixtures/world.js';
import { describeInfra } from '../../../../test/helpers/infra.js';
import { DomainError } from '../../../platform/errors/domain-error.js';
import { DELETED_USER_NAME, PROFILES_API, type ProfilesApi } from '../public.js';
import { codeOf, labelOf } from './support.js';

describeInfra('profiles facade (ProfilesApi for teams and matching)', ['db', 'redis'], () => {
  let world: World;
  let api: ProfilesApi;

  beforeAll(async () => {
    world = await World.start({ worker: false });
    await world.ensureCatalog(PROFILE_ROLES, PROFILE_STACK);
    api = world.app.get<ProfilesApi>(PROFILES_API, { strict: false });
  });

  afterAll(async () => {
    await world.close();
  });

  async function personWithRole(role: string, hours = 10): Promise<string> {
    const user = await world.createUser(labelOf('facade'));
    await insertProfile(world.sql, user.id, {
      hoursPerWeek: hours,
      rolePrefs: [{ roleCode: role, level: 'middle' }],
    });
    return user.id;
  }

  it('returns sorted stack and role prefs in priority order, and omits users without a profile', async () => {
    const user = await world.createUser(labelOf('facade'));
    const bare = await world.createUser(labelOf('bare'));
    await insertProfile(world.sql, user.id, {
      stack: ['typescript', 'react'],
      rolePrefs: [
        { roleCode: 'pm', level: 'beginner' },
        { roleCode: 'backend', level: 'junior' },
      ],
    });
    const result = await api.getMatchingProfiles([user.id, bare.id]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      userId: user.id,
      stack: ['react', 'typescript'],
      rolePrefs: [
        { roleCode: 'pm', level: 'beginner' },
        { roleCode: 'backend', level: 'junior' },
      ],
    });
  });

  it('returns an empty list for an empty id list', async () => {
    expect(await api.getMatchingProfiles([])).toEqual([]);
  });

  it('pages profiles of a role by user id with a cursor and no repeats', async () => {
    const role = codeOf('pager').slice(0, 30);
    await world.ensureCatalog([role]);
    const ids = [
      await personWithRole(role),
      await personWithRole(role),
      await personWithRole(role),
    ].sort();
    const first = await api.listMatchingProfilesByRole(role, { limit: 2 });
    expect(first.items.map((p) => p.userId)).toEqual(ids.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();
    const second = await api.listMatchingProfilesByRole(role, {
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.items.map((p) => p.userId)).toEqual(ids.slice(2));
    expect(second.nextCursor).toBeNull();
  });

  it('rejects a cursor issued for another role', async () => {
    const roleA = codeOf('cura').slice(0, 30);
    const roleB = codeOf('curb').slice(0, 30);
    await world.ensureCatalog([roleA, roleB]);
    await personWithRole(roleA);
    await personWithRole(roleA);
    const page = await api.listMatchingProfilesByRole(roleA, { limit: 1 });
    await expect(
      api.listMatchingProfilesByRole(roleB, { limit: 1, cursor: page.nextCursor as string }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  describe('people who may not be matched (privacy)', () => {
    async function people(role: string) {
      const good = await personWithRole(role);
      const deleting = await world.createUser(labelOf('deleting'), { status: 'deleting' });
      const noConsent = await world.createUser(labelOf('noconsent'), { consent: false });
      const outdated = await world.createUser(labelOf('outdated'), { consent: 'outdated' });
      for (const user of [deleting, noConsent, outdated]) {
        await insertProfile(world.sql, user.id, {
          rolePrefs: [{ roleCode: role, level: 'middle' }],
        });
      }
      return { good, hidden: [deleting.id, noConsent.id, outdated.id] };
    }

    it('getMatchingProfiles leaves out accounts that are not active or have no valid consent', async () => {
      const role = codeOf('privacy').slice(0, 30);
      await world.ensureCatalog([role]);
      const { good, hidden } = await people(role);
      const result = await api.getMatchingProfiles([good, ...hidden]);
      expect(result.map((p) => p.userId)).toEqual([good]);
    });

    it('listMatchingProfilesByRole leaves out accounts that are not active or have no valid consent', async () => {
      const role = codeOf('privlist').slice(0, 30);
      await world.ensureCatalog([role]);
      const { good } = await people(role);
      const page = await api.listMatchingProfilesByRole(role, { limit: 50 });
      expect(page.items.map((p) => p.userId)).toEqual([good]);
    });

    it('the queue run may still read them to meet them at lock #1 (includeIneligible)', async () => {
      const role = codeOf('privqueue').slice(0, 30);
      await world.ensureCatalog([role]);
      const { good, hidden } = await people(role);
      const result = await api.getMatchingProfiles([good, ...hidden], { includeIneligible: true });
      expect(result.map((p) => p.userId).sort()).toEqual([good, ...hidden].sort());
    });
  });

  it('maps users without a profile to the deleted-user name', async () => {
    const user = await world.createUser(labelOf('named'));
    const ghost = await world.createUser(labelOf('ghost'));
    await insertProfile(world.sql, user.id, { displayName: 'Мария' });
    const names = await api.getDisplayNames([user.id, ghost.id]);
    expect(names.get(user.id)).toBe('Мария');
    expect(names.get(ghost.id)).toBe(DELETED_USER_NAME);
    expect((await api.getDisplayNames([])).size).toBe(0);
  });

  it('lists only active roles unless inactive ones are requested', async () => {
    const hidden = codeOf('inactive').slice(0, 30);
    await world.ensureCatalog([hidden]);
    await world.sql`UPDATE profiles.role SET active = false WHERE code = ${hidden}`;
    const active = (await api.listRoles()).map((r) => r.code);
    const all = (await api.listRoles({ includeInactive: true })).map((r) => r.code);
    expect(active).not.toContain(hidden);
    expect(all).toContain(hidden);
  });

  it('reports unknown role codes with their positions and treats inactive roles as unknown when activeOnly', async () => {
    const hidden = codeOf('off').slice(0, 30);
    await world.ensureCatalog([hidden]);
    await world.sql`UPDATE profiles.role SET active = false WHERE code = ${hidden}`;
    await api.assertRolesExist([]);
    await api.assertRolesExist(['backend', hidden]);
    const error = await api
      .assertRolesExist(['backend', 'no_such_role', hidden], { activeOnly: true })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).data.errors?.map((e) => e.pointer)).toEqual(['/1', '/2']);
  });

  it('validates stack tag codes', async () => {
    await api.assertStackTagsExist([]);
    await api.assertStackTagsExist(['typescript']);
    await expect(api.assertStackTagsExist(['typescript', 'nope_tag'])).rejects.toBeInstanceOf(
      DomainError,
    );
  });
});
