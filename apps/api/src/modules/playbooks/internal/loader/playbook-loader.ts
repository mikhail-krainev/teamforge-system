import { and, desc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Database } from '../../../../platform/db/db.module.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { registerConstraint } from '../../../../platform/errors/constraints.js';
import {
  platformTemplate,
  playbook,
  productType,
  stage,
  step,
  stepFallback,
  stepReviewItem,
} from '../schema/playbooks.js';
import type { PlaybookWarning } from './issue.js';
import type { PlaybookCatalogs } from './playbook-rules.js';
import { compareSemver } from './semver.js';
import { type ValidPlaybook, validatePlaybookSource } from './validate-playbook.js';

// Two concurrent uploads of one version: the loser of the unique index answers like a lower version.
registerConstraint('playbook_type_version_uq', {
  code: 'PLAYBOOK_VERSION_NOT_GREATER',
  status: 409,
});

/** `PlaybookSummary` of the contract. */
export interface PlaybookSummaryDto {
  id: string;
  productTypeCode: string;
  title: string;
  version: string;
  status: 'draft' | 'published';
  totalDays: number;
  publishedAt: string | null;
}

export interface UploadResult {
  playbook: PlaybookSummaryDto;
  warnings: PlaybookWarning[];
}

export type LoadOutcome = 'created' | 'published' | 'unchanged';

type PlaybookRow = typeof playbook.$inferSelect;

export function toSummary(row: PlaybookRow): PlaybookSummaryDto {
  return {
    id: row.id,
    productTypeCode: row.productTypeCode,
    title: row.title,
    version: row.version,
    status: row.status as 'draft' | 'published',
    totalDays: row.totalDays,
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}

interface TreeRows {
  stages: (typeof stage.$inferInsert)[];
  steps: (typeof step.$inferInsert)[];
  reviewItems: (typeof stepReviewItem.$inferInsert)[];
  fallbacks: (typeof stepFallback.$inferInsert)[];
}

type FileStep = ValidPlaybook['file']['stages'][number]['steps'][number];

function stepRow(playbookId: string, stageId: string, st: FileStep, ordinal: number) {
  return {
    id: uuidv7(),
    playbookId,
    stageId,
    key: st.key,
    ordinal,
    title: st.title,
    description: st.description,
    kind: st.type,
    submission: st.type === 'artifact' ? (st.submission ?? null) : null,
    ritualKind: st.type === 'ritual' ? (st.ritual_kind ?? null) : null,
    required: st.required,
    ownerRole: st.owner_role,
    altRoles: st.alt_roles ?? [],
    reviewChecklist: st.review_checklist,
    autoChecks: st.auto_checks ?? [],
    sources: st.sources,
  } satisfies typeof step.$inferInsert;
}

/** Rows of all child tables for a checked file; ordinals follow the order in the file. */
function treeRows(playbookId: string, valid: ValidPlaybook): TreeRows {
  const rows: TreeRows = { stages: [], steps: [], reviewItems: [], fallbacks: [] };
  valid.file.stages.forEach((s, i) => {
    const stageId = uuidv7();
    rows.stages.push({
      id: stageId,
      playbookId,
      key: s.key,
      ordinal: i + 1,
      title: s.title,
      goal: s.goal,
      durationDays: s.duration_days,
      exitCriteria: s.exit_criteria,
    });
    s.steps.forEach((st, j) => {
      const row = stepRow(playbookId, stageId, st, j + 1);
      rows.steps.push(row);
      (st.review_items ?? []).forEach((text, k) => {
        rows.reviewItems.push({ stepId: row.id, ordinal: k + 1, text });
      });
      if (st.fallback != null) {
        rows.fallbacks.push({
          stepId: row.id,
          title: st.fallback.title,
          instruction: st.fallback.instruction,
          templateKey: st.fallback.template,
          url: st.fallback.url ?? null,
        });
      }
    });
  });
  return rows;
}

/** One upload or publication per product type at a time, so that "greater than the last version" cannot race. */
async function lockProductType(tx: Database, code: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`playbooks.upload:${code}`}, 0))`,
  );
}

/**
 * Loading and publishing of playbooks (architecture 11.1). Plain class over a transaction handle: the HTTP
 * service (`PlaybookAdminService`) and the CLI (`playbooks:load`, no Nest) run the very same code.
 * Every method takes the transaction it must run in.
 */
export class PlaybookLoader {
  /** Role and template catalogs against which a file is checked. */
  async catalogs(tx: Database, roleCodes: Iterable<string>): Promise<PlaybookCatalogs> {
    const rows = await tx.selectDistinct({ key: platformTemplate.key }).from(platformTemplate);
    return { roles: new Set(roleCodes), templates: new Set(rows.map((row) => row.key)) };
  }

  /** Check of a file; throws 422 PLAYBOOK_INVALID with every finding. */
  async validate(tx: Database, text: string, roleCodes: Iterable<string>): Promise<ValidPlaybook> {
    const result = validatePlaybookSource(text, await this.catalogs(tx, roleCodes));
    if (!result.ok) {
      throw new DomainError('PLAYBOOK_INVALID', 422, {
        detail: `The playbook has ${result.errors.length} error(s)`,
        errors: result.errors,
      });
    }
    return result.playbook;
  }

  /** FR-PLAY-01/-02/-07: check and store as a draft. */
  async upload(
    tx: Database,
    text: string,
    uploadedBy: string,
    roleCodes: Iterable<string>,
  ): Promise<UploadResult> {
    const valid = await this.validate(tx, text, roleCodes);
    const row = await this.insertDraft(tx, valid, uploadedBy);
    return { playbook: toSummary(row), warnings: valid.warnings };
  }

  /** Stores a checked playbook as a draft; 409 PLAYBOOK_VERSION_NOT_GREATER unless its semver is the highest of the type. */
  async insertDraft(tx: Database, valid: ValidPlaybook, uploadedBy: string): Promise<PlaybookRow> {
    const { file, semver } = valid;
    await lockProductType(tx, file.product_type);
    const [latest] = await tx
      .select({
        version: playbook.version,
        major: playbook.vMajor,
        minor: playbook.vMinor,
        patch: playbook.vPatch,
      })
      .from(playbook)
      .where(eq(playbook.productTypeCode, file.product_type))
      .orderBy(desc(playbook.vMajor), desc(playbook.vMinor), desc(playbook.vPatch))
      .limit(1);
    if (
      latest !== undefined &&
      compareSemver(semver, { major: latest.major, minor: latest.minor, patch: latest.patch }) <= 0
    ) {
      throw new DomainError('PLAYBOOK_VERSION_NOT_GREATER', 409, {
        detail: `Version ${file.version} must be greater than ${latest.version}`,
        current: { version: latest.version },
      });
    }
    // A new product type is created by the same file; it stays inactive until a playbook is published.
    await tx
      .insert(productType)
      .values({ code: file.product_type, name: file.title, active: false })
      .onConflictDoNothing();
    const [row] = await tx
      .insert(playbook)
      .values({
        id: uuidv7(),
        productTypeCode: file.product_type,
        title: file.title,
        version: file.version,
        vMajor: semver.major,
        vMinor: semver.minor,
        vPatch: semver.patch,
        status: 'draft',
        totalDays: file.total_days,
        sourceText: valid.sourceText,
        sourceSha256: valid.sourceSha256,
        uploadedBy,
        publishedAt: null,
      })
      .returning();
    if (row === undefined) throw new Error('playbook insert returned no row');
    await this.insertTree(tx, row.id, valid);
    return row;
  }

  private async insertTree(tx: Database, playbookId: string, valid: ValidPlaybook): Promise<void> {
    const rows = treeRows(playbookId, valid);
    await tx.insert(stage).values(rows.stages);
    await tx.insert(step).values(rows.steps);
    if (rows.reviewItems.length > 0) await tx.insert(stepReviewItem).values(rows.reviewItems);
    if (rows.fallbacks.length > 0) await tx.insert(stepFallback).values(rows.fallbacks);
  }

  /**
   * FR-PLAY-03/-04: a draft becomes published, once and for good. 404 for an unknown id, 409
   * PLAYBOOK_PUBLISHED_IMMUTABLE for a published one, 409 PLAYBOOK_VERSION_NOT_GREATER when a higher
   * version of the type is already published. The first publication of a type makes the type available
   * for new teams (`product_type.active`).
   */
  async publish(tx: Database, playbookId: string, now: Date): Promise<PlaybookSummaryDto> {
    const [row] = await tx.select().from(playbook).where(eq(playbook.id, playbookId)).for('update');
    if (row === undefined) throw new DomainError('NOT_FOUND', 404);
    if (row.status === 'published') {
      throw new DomainError('PLAYBOOK_PUBLISHED_IMMUTABLE', 409, {
        detail: `Playbook ${row.productTypeCode} ${row.version} is already published`,
      });
    }
    await lockProductType(tx, row.productTypeCode);
    const [published] = await tx
      .select({
        version: playbook.version,
        major: playbook.vMajor,
        minor: playbook.vMinor,
        patch: playbook.vPatch,
      })
      .from(playbook)
      .where(
        and(eq(playbook.productTypeCode, row.productTypeCode), eq(playbook.status, 'published')),
      )
      .orderBy(desc(playbook.vMajor), desc(playbook.vMinor), desc(playbook.vPatch))
      .limit(1);
    if (
      published !== undefined &&
      compareSemver(
        { major: row.vMajor, minor: row.vMinor, patch: row.vPatch },
        { major: published.major, minor: published.minor, patch: published.patch },
      ) <= 0
    ) {
      throw new DomainError('PLAYBOOK_VERSION_NOT_GREATER', 409, {
        detail: `Version ${row.version} must be greater than the published ${published.version}`,
        current: { version: published.version },
      });
    }
    const [updated] = await tx
      .update(playbook)
      .set({ status: 'published', publishedAt: now })
      .where(eq(playbook.id, playbookId))
      .returning();
    if (updated === undefined) throw new Error('playbook update returned no row');
    await tx
      .update(productType)
      .set({ active: true })
      .where(eq(productType.code, row.productTypeCode));
    return toSummary(updated);
  }

  /**
   * Idempotent load for the CLI and the seed: the same file (same SHA-256) loaded again changes nothing;
   * another file under an existing version is refused as a version that is not greater.
   */
  async ensureLoaded(
    tx: Database,
    text: string,
    options: { uploadedBy: string; publish: boolean; roleCodes: Iterable<string>; now: Date },
  ): Promise<{ outcome: LoadOutcome; playbook: PlaybookSummaryDto; warnings: PlaybookWarning[] }> {
    const valid = await this.validate(tx, text, options.roleCodes);
    await lockProductType(tx, valid.file.product_type);
    const [existing] = await tx
      .select()
      .from(playbook)
      .where(
        and(
          eq(playbook.productTypeCode, valid.file.product_type),
          eq(playbook.version, valid.file.version),
        ),
      );
    if (existing === undefined) {
      const row = await this.insertDraft(tx, valid, options.uploadedBy);
      const created = options.publish
        ? await this.publish(tx, row.id, options.now)
        : toSummary(row);
      return {
        outcome: options.publish ? 'published' : 'created',
        playbook: created,
        warnings: valid.warnings,
      };
    }
    if (!existing.sourceSha256.equals(valid.sourceSha256)) {
      throw new DomainError('PLAYBOOK_VERSION_NOT_GREATER', 409, {
        detail: `Version ${existing.version} of ${existing.productTypeCode} exists with other content`,
        current: { version: existing.version },
      });
    }
    if (options.publish && existing.status === 'draft') {
      return {
        outcome: 'published',
        playbook: await this.publish(tx, existing.id, options.now),
        warnings: valid.warnings,
      };
    }
    return { outcome: 'unchanged', playbook: toSummary(existing), warnings: valid.warnings };
  }
}
