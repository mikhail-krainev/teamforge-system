import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, or, sql, type SQL } from 'drizzle-orm';
import { DB, type Database } from '../../../../platform/db/db.module.js';
import type { PlaybookDefinition, StageDefinition, StepDefinition } from '../../public.js';
import {
  platformTemplate,
  playbook,
  stage,
  step,
  stepFallback,
  stepReviewItem,
} from '../schema/playbooks.js';

function groupBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  return groups;
}

export type PlaybookRow = typeof playbook.$inferSelect;

interface TreeRows {
  stages: (typeof stage.$inferSelect)[];
  steps: (typeof step.$inferSelect)[];
  items: (typeof stepReviewItem.$inferSelect)[];
  fallbacks: (typeof stepFallback.$inferSelect)[];
}

function stepFull(
  st: typeof step.$inferSelect,
  items: (typeof stepReviewItem.$inferSelect)[],
  fallback: typeof stepFallback.$inferSelect | undefined,
): StepFull {
  return {
    key: st.key,
    ordinal: st.ordinal,
    title: st.title,
    description: st.description,
    kind: st.kind as StepDefinition['kind'],
    submission: st.submission as StepDefinition['submission'],
    ritualKind: st.ritualKind as StepDefinition['ritualKind'],
    required: st.required,
    ownerRole: st.ownerRole,
    altRoles: st.altRoles,
    fallback:
      fallback === undefined
        ? null
        : {
            title: fallback.title,
            instruction: fallback.instruction,
            template: fallback.templateKey,
            url: fallback.url,
          },
    reviewChecklist: st.reviewChecklist,
    reviewItems: items.map((item) => item.text),
    autoChecks: st.autoChecks,
    sources: st.sources,
  };
}

/** Joins the rows of the four tables into the tree (rows arrive ordered by ordinal). */
function assemble(row: PlaybookRow, rows: TreeRows): PlaybookFull {
  const itemsByStep = groupBy(rows.items, (item) => item.stepId);
  const stepsByStage = groupBy(rows.steps, (s) => s.stageId);
  const fallbackByStep = new Map(rows.fallbacks.map((f) => [f.stepId, f]));
  return {
    row,
    stages: rows.stages.map((s): StageFull => ({
      key: s.key,
      ordinal: s.ordinal,
      title: s.title,
      goal: s.goal,
      durationDays: s.durationDays,
      exitCriteria: s.exitCriteria,
      steps: (stepsByStage.get(s.id) ?? []).map((st) =>
        stepFull(st, itemsByStep.get(st.id) ?? [], fallbackByStep.get(st.id)),
      ),
    })),
  };
}

export interface StepFull extends StepDefinition {
  sources: string[];
}

export interface StageFull extends StageDefinition {
  steps: StepFull[];
}

/** A playbook as stored: summary columns plus the whole tree. */
export interface PlaybookFull {
  row: PlaybookRow;
  stages: StageFull[];
}

export interface ListFilter {
  productType?: string | undefined;
  /** Drafts are visible to administrators only. */
  includeDrafts: boolean;
  /** Keyset position: the last row of the previous page. */
  after?: { productType: string; major: number; minor: number; patch: number } | undefined;
  limit: number;
}

export interface TemplateRow {
  key: string;
  version: number;
  title: string;
  bodyMd: string;
}

/** SQL of the read side. Reads go through the application connection, never inside a write transaction. */
@Injectable()
export class PlaybookReader {
  constructor(@Inject(DB) private readonly db: Database) {}

  async findRow(id: string): Promise<PlaybookRow | undefined> {
    const [row] = await this.db.select().from(playbook).where(eq(playbook.id, id));
    return row;
  }

  /**
   * Page of playbooks ordered by product type, then newest version first. Served by the unique index
   * `(product_type_code, version)`; the page reads `limit + 1` rows so that the caller can tell whether a next page exists.
   */
  list(filter: ListFilter): Promise<PlaybookRow[]> {
    const conditions: (SQL | undefined)[] = [
      filter.includeDrafts ? undefined : eq(playbook.status, 'published'),
      filter.productType === undefined
        ? undefined
        : eq(playbook.productTypeCode, filter.productType),
      filter.after === undefined
        ? undefined
        : or(
            gt(playbook.productTypeCode, filter.after.productType),
            and(
              eq(playbook.productTypeCode, filter.after.productType),
              sql`(${playbook.vMajor}, ${playbook.vMinor}, ${playbook.vPatch}) < (${filter.after.major}, ${filter.after.minor}, ${filter.after.patch})`,
            ),
          ),
    ];
    return this.db
      .select()
      .from(playbook)
      .where(and(...conditions))
      .orderBy(
        asc(playbook.productTypeCode),
        desc(playbook.vMajor),
        desc(playbook.vMinor),
        desc(playbook.vPatch),
      )
      .limit(filter.limit + 1);
  }

  /** The whole tree of one playbook; four queries regardless of its size. */
  async loadTree(row: PlaybookRow): Promise<PlaybookFull> {
    const stages = await this.db
      .select()
      .from(stage)
      .where(eq(stage.playbookId, row.id))
      .orderBy(asc(stage.ordinal));
    const steps = await this.db
      .select()
      .from(step)
      .where(eq(step.playbookId, row.id))
      .orderBy(asc(step.ordinal));
    const stepIds = steps.map((s) => s.id);
    const noSteps = stepIds.length === 0;
    const items = noSteps
      ? []
      : await this.db
          .select()
          .from(stepReviewItem)
          .where(inArray(stepReviewItem.stepId, stepIds))
          .orderBy(asc(stepReviewItem.stepId), asc(stepReviewItem.ordinal));
    const fallbacks = noSteps
      ? []
      : await this.db.select().from(stepFallback).where(inArray(stepFallback.stepId, stepIds));
    return assemble(row, { stages, steps, items, fallbacks });
  }

  /** Highest version of a template. */
  async latestTemplate(key: string): Promise<TemplateRow | undefined> {
    const [row] = await this.db
      .select()
      .from(platformTemplate)
      .where(eq(platformTemplate.key, key))
      .orderBy(desc(platformTemplate.version))
      .limit(1);
    return row;
  }
}

export function toDefinition(full: PlaybookFull): PlaybookDefinition {
  return {
    id: full.row.id,
    productType: full.row.productTypeCode,
    version: full.row.version,
    totalDays: full.row.totalDays,
    stages: full.stages,
  };
}
