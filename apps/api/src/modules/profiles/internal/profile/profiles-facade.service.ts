import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { Database } from '../../../../platform/db/db.module.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import {
  buildPage,
  clampLimit,
  decodeCursor,
  type Page,
} from '../../../../platform/db/pagination.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import {
  DELETED_USER_NAME,
  type Level,
  type MatchingProfile,
  type PageQuery,
  type ProfilesApi,
  type RoleCode,
  type UserId,
} from '../../public.js';
import { profile, profileRolePref, profileStack, role, stackTag } from '../schema/profiles.js';

/** Read-only facade for teams and matching (`ProfilesApi`). */
@Injectable()
export class ProfilesFacade implements ProfilesApi {
  constructor(
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(AUTH_API) private readonly auth: AuthApi,
  ) {}

  /**
   * The client of the active transaction, else the pool. A read made inside a transaction must use
   * the transaction's connection: taking a second one from the pool starves it (architecture 12.1).
   */
  private get db(): Database {
    return this.tx.tx;
  }

  async getMatchingProfiles(
    userIds: UserId[],
    options: { includeIneligible?: boolean } = {},
  ): Promise<MatchingProfile[]> {
    if (userIds.length === 0) return [];
    const matchable =
      options.includeIneligible === true ? undefined : await this.auth.filterMatchable(userIds);
    const [allRows, tags, prefs] = await Promise.all([
      this.db.select().from(profile).where(inArray(profile.userId, userIds)),
      this.db.select().from(profileStack).where(inArray(profileStack.userId, userIds)),
      this.db
        .select()
        .from(profileRolePref)
        .where(inArray(profileRolePref.userId, userIds))
        .orderBy(asc(profileRolePref.ordinal)),
    ]);
    const rows = allRows.filter((row) => matchable === undefined || matchable.has(row.userId));
    return rows.map((row) => ({
      userId: row.userId,
      timezone: row.timezone,
      hoursPerWeek: row.hoursPerWeek,
      stack: tags
        .filter((t) => t.userId === row.userId)
        .map((t) => t.stackTagCode)
        .sort(),
      rolePrefs: prefs
        .filter((p) => p.userId === row.userId)
        .map((p) => ({ roleCode: p.roleCode, level: p.level as Level })),
    }));
  }

  async listMatchingProfilesByRole(
    roleCode: RoleCode,
    query: PageQuery,
  ): Promise<Page<MatchingProfile>> {
    const filters = { role: roleCode };
    const limit = clampLimit(query.limit);
    const after =
      query.cursor === undefined ? undefined : String(decodeCursor(query.cursor, filters).k[0]);
    const ids = await this.db
      .select({ userId: profileRolePref.userId })
      .from(profileRolePref)
      .where(
        and(
          eq(profileRolePref.roleCode, roleCode),
          after === undefined ? undefined : gt(profileRolePref.userId, after),
        ),
      )
      .orderBy(asc(profileRolePref.userId))
      .limit(limit + 1);
    const page = buildPage(ids, limit, (row) => [row.userId], filters);
    const profiles = await this.getMatchingProfiles(page.items.map((row) => row.userId));
    const byId = new Map(profiles.map((p) => [p.userId, p]));
    return {
      items: page.items.flatMap((row) => byId.get(row.userId) ?? []),
      nextCursor: page.nextCursor,
    };
  }

  async getDisplayNames(userIds: UserId[]): Promise<Map<UserId, string>> {
    const names = new Map<UserId, string>(userIds.map((id) => [id, DELETED_USER_NAME]));
    if (userIds.length === 0) return names;
    const rows = await this.db
      .select({ userId: profile.userId, displayName: profile.displayName })
      .from(profile)
      .where(inArray(profile.userId, userIds));
    for (const row of rows) names.set(row.userId, row.displayName);
    return names;
  }

  listRoles(options: { includeInactive?: boolean } = {}) {
    return this.db
      .select({ code: role.code, name: role.name, active: role.active })
      .from(role)
      .where(options.includeInactive ? undefined : eq(role.active, true))
      .orderBy(asc(role.ordinal), asc(role.code));
  }

  async assertRolesExist(codes: RoleCode[], options: { activeOnly?: boolean } = {}): Promise<void> {
    if (codes.length === 0) return;
    const rows = await this.db
      .select({ code: role.code })
      .from(role)
      .where(
        and(inArray(role.code, codes), options.activeOnly ? eq(role.active, true) : undefined),
      );
    this.assertAllFound(codes, new Set(rows.map((r) => r.code)));
  }

  async assertStackTagsExist(codes: string[]): Promise<void> {
    if (codes.length === 0) return;
    const rows = await this.db
      .select({ code: stackTag.code })
      .from(stackTag)
      .where(inArray(stackTag.code, codes));
    this.assertAllFound(codes, new Set(rows.map((r) => r.code)));
  }

  private assertAllFound(codes: string[], found: Set<string>): void {
    const errors = codes.flatMap((code, index) =>
      found.has(code)
        ? []
        : [
            {
              pointer: `/${index}`,
              code: 'unknown_catalog_entry',
              message: 'Unknown catalog entry',
            },
          ],
    );
    if (errors.length > 0) throw new DomainError('VALIDATION_FAILED', 422, { errors });
  }
}
