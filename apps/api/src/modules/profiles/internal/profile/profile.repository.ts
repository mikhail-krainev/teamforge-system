import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import {
  profile,
  profileExperience,
  profileRolePref,
  profileStack,
  role,
  stackTag,
} from '../schema/profiles.js';
import type { CatalogState } from './profile-rules.js';
import type { Level, ProfileDto, ProfileInput } from './profile.types.js';

type ProfileRow = typeof profile.$inferSelect;

/** Normalised hash of the free text of a profile (AF-18: identical texts of different accounts). */
function textFingerprint(input: ProfileInput): Buffer | null {
  const text = [...input.strengths, ...input.weaknesses]
    .join(' ')
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return text === '' ? null : createHash('sha256').update(text).digest();
}

function toDto(
  row: ProfileRow,
  parts: Pick<ProfileDto, 'stack' | 'rolePrefs' | 'experience'>,
): ProfileDto {
  return {
    userId: row.userId,
    displayName: row.displayName,
    timezone: row.timezone,
    hoursPerWeek: row.hoursPerWeek,
    portfolioUrl: row.portfolioUrl,
    ...parts,
    strengths: row.strengths as string[],
    weaknesses: row.weaknesses as string[],
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function profileColumns(input: ProfileInput, now: Date) {
  return {
    displayName: input.displayName,
    timezone: input.timezone,
    hoursPerWeek: input.hoursPerWeek,
    portfolioUrl: input.portfolioUrl ?? null,
    strengths: input.strengths,
    weaknesses: input.weaknesses,
    textFingerprint: textFingerprint(input),
    updatedAt: now,
  };
}

/** SQL of the profile and its child tables; every method joins the active transaction. */
@Injectable()
export class ProfileRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  async find(userId: string): Promise<ProfileDto | undefined> {
    const db = this.tx.tx;
    const rows = await db.select().from(profile).where(eq(profile.userId, userId));
    const row = rows[0];
    if (row === undefined) return undefined;
    const [stack, prefs, experience] = await Promise.all([
      db
        .select({ code: profileStack.stackTagCode })
        .from(profileStack)
        .where(eq(profileStack.userId, userId))
        .orderBy(asc(profileStack.stackTagCode)),
      db
        .select()
        .from(profileRolePref)
        .where(eq(profileRolePref.userId, userId))
        .orderBy(asc(profileRolePref.ordinal)),
      db
        .select()
        .from(profileExperience)
        .where(eq(profileExperience.userId, userId))
        .orderBy(asc(profileExperience.ordinal)),
    ]);
    return toDto(row, {
      stack: stack.map((s) => s.code),
      rolePrefs: prefs.map((p) => ({ roleCode: p.roleCode, level: p.level as Level })),
      experience: experience.map((e) => ({
        title: e.title,
        ...(e.description === null ? {} : { description: e.description }),
        from: e.periodFrom,
        to: e.periodTo,
      })),
    });
  }

  /** First save: false when another request created the profile first. */
  async insertIfAbsent(userId: string, input: ProfileInput, now: Date): Promise<boolean> {
    const rows = await this.tx.tx
      .insert(profile)
      .values({ userId, version: 1, ...profileColumns(input, now) })
      .onConflictDoNothing()
      .returning({ userId: profile.userId });
    return rows.length > 0;
  }

  /** Optimistic update: false when the stored version is not `version` (or there is no profile). */
  async updateIfVersion(
    userId: string,
    input: ProfileInput,
    version: number,
    now: Date,
  ): Promise<boolean> {
    const rows = await this.tx.tx
      .update(profile)
      .set({ ...profileColumns(input, now), version: sql`${profile.version} + 1` })
      .where(and(eq(profile.userId, userId), eq(profile.version, version)))
      .returning({ userId: profile.userId });
    return rows.length > 0;
  }

  /** Replaces roles, stack and experience; the caller owns the profile row lock. */
  async replaceChildren(userId: string, input: ProfileInput): Promise<void> {
    const db = this.tx.tx;
    await db.delete(profileRolePref).where(eq(profileRolePref.userId, userId));
    await db.delete(profileStack).where(eq(profileStack.userId, userId));
    await db.delete(profileExperience).where(eq(profileExperience.userId, userId));
    if (input.rolePrefs.length > 0) {
      await db.insert(profileRolePref).values(
        input.rolePrefs.map((pref, ordinal) => ({
          userId,
          roleCode: pref.roleCode,
          level: pref.level,
          ordinal,
        })),
      );
    }
    if (input.stack.length > 0) {
      await db
        .insert(profileStack)
        .values(input.stack.map((stackTagCode) => ({ userId, stackTagCode })));
    }
    if (input.experience.length > 0) {
      await db.insert(profileExperience).values(
        input.experience.map((entry, ordinal) => ({
          id: randomUUID(),
          userId,
          title: entry.title,
          description: entry.description ?? null,
          periodFrom: entry.from,
          periodTo: entry.to ?? null,
          ordinal,
        })),
      );
    }
  }

  /** Catalog flags of the codes in `input` plus the codes the profile already holds. */
  async catalogState(userId: string, input: ProfileInput): Promise<CatalogState> {
    const db = this.tx.tx;
    const roleCodes = input.rolePrefs.map((p) => p.roleCode);
    const [roles, tags, heldRoles, heldStack] = await Promise.all([
      roleCodes.length === 0
        ? []
        : db
            .select({ code: role.code, active: role.active })
            .from(role)
            .where(inArray(role.code, roleCodes)),
      input.stack.length === 0
        ? []
        : db
            .select({ code: stackTag.code, active: stackTag.active })
            .from(stackTag)
            .where(inArray(stackTag.code, input.stack)),
      db
        .select({ code: profileRolePref.roleCode })
        .from(profileRolePref)
        .where(eq(profileRolePref.userId, userId)),
      db
        .select({ code: profileStack.stackTagCode })
        .from(profileStack)
        .where(eq(profileStack.userId, userId)),
    ]);
    return {
      roles: new Map(roles.map((r) => [r.code, r.active])),
      stack: new Map(tags.map((t) => [t.code, t.active])),
      heldRoles: new Set(heldRoles.map((r) => r.code)),
      heldStack: new Set(heldStack.map((s) => s.code)),
    };
  }
}
