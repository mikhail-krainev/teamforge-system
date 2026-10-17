import {
  autoCheckName,
  checkAutoCheckKey,
  RELEASE_AUTO_CHECKS,
  REPO_FINAL_CHECK,
} from './auto-checks.js';
import type { PlaybookIssue, PlaybookWarning } from './issue.js';
import { parseSemver } from './semver.js';

/** Catalogs a playbook refers to (FR-PLAY-02). */
export interface PlaybookCatalogs {
  /** Codes of `profiles.role` (active or not). */
  roles: ReadonlySet<string>;
  /** Keys of `playbooks.platform_template`. */
  templates: ReadonlySet<string>;
}

/** Plan range of a project in weeks (FR-PLAY-07): outside it only a warning. */
export const MIN_PLAN_WEEKS = 10;
export const MAX_PLAN_WEEKS = 16;

type Fallback = 'absent' | 'null' | 'object';

/** What the rules need of a step, read leniently: a field of the wrong type is simply unknown (zod reports it). */
interface StepFacts {
  pointer: string;
  key: string | undefined;
  type: string | undefined;
  required: boolean | undefined;
  hasSubmission: boolean;
  hasRitualKind: boolean;
  ownerRole: string | undefined;
  altRoles: string[];
  fallback: Fallback;
  template: string | undefined;
  reviewChecklist: boolean | undefined;
  reviewItems: number;
  autoChecks: string[];
}

interface StageFacts {
  pointer: string;
  key: string | undefined;
  durationDays: number | undefined;
  steps: StepFacts[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function fallbackOf(value: unknown): Fallback {
  if (value === undefined) return 'absent';
  return value === null ? 'null' : 'object';
}

function stepFacts(raw: unknown, pointer: string): StepFacts {
  const step = isRecord(raw) ? raw : {};
  return {
    pointer,
    key: asString(step.key),
    type: asString(step.type),
    required: typeof step.required === 'boolean' ? step.required : undefined,
    hasSubmission: step.submission !== undefined && step.submission !== null,
    hasRitualKind: step.ritual_kind !== undefined && step.ritual_kind !== null,
    ownerRole: asString(step.owner_role),
    altRoles: Array.isArray(step.alt_roles) ? step.alt_roles.map((r) => asString(r) ?? '') : [],
    fallback: fallbackOf(step.fallback),
    template: isRecord(step.fallback) ? asString(step.fallback.template) : undefined,
    reviewChecklist: typeof step.review_checklist === 'boolean' ? step.review_checklist : undefined,
    reviewItems: Array.isArray(step.review_items) ? step.review_items.length : 0,
    autoChecks: strings(step.auto_checks),
  };
}

function stageFacts(raw: unknown, pointer: string): StageFacts {
  const stage = isRecord(raw) ? raw : {};
  const steps: unknown[] = Array.isArray(stage.steps) ? stage.steps : [];
  const days = stage.duration_days;
  return {
    pointer,
    key: asString(stage.key),
    durationDays: typeof days === 'number' && Number.isInteger(days) && days > 0 ? days : undefined,
    steps: steps.map((step, j) => stepFacts(step, `${pointer}/steps/${j}`)),
  };
}

function checkDuplicates(
  items: { pointer: string; key: string | undefined }[],
  what: string,
  issues: PlaybookIssue[],
): void {
  const seen = new Map<string, string>();
  for (const item of items) {
    if (item.key === undefined) continue;
    const first = seen.get(item.key);
    if (first === undefined) {
      seen.set(item.key, item.pointer);
    } else {
      issues.push({
        pointer: `${item.pointer}/key`,
        code: 'duplicate_key',
        message: `${what} key "${item.key}" is already used at ${first}/key`,
      });
    }
  }
}

function checkRoles(step: StepFacts, roles: ReadonlySet<string>, issues: PlaybookIssue[]): void {
  const { ownerRole, pointer } = step;
  if (ownerRole !== undefined && ownerRole !== 'any' && !roles.has(ownerRole)) {
    issues.push({
      pointer: `${pointer}/owner_role`,
      code: 'unknown_role',
      message: `Role "${ownerRole}" is not in the role catalog`,
    });
  }
  step.altRoles.forEach((role, k) => {
    if (!roles.has(role)) {
      issues.push({
        pointer: `${pointer}/alt_roles/${k}`,
        code: 'unknown_role',
        message: `Role "${role}" is not in the role catalog`,
      });
    } else if (role === ownerRole) {
      issues.push({
        pointer: `${pointer}/alt_roles/${k}`,
        code: 'alt_role_is_owner',
        message: 'alt_roles must not contain owner_role',
      });
    }
  });
}

function checkFallback(
  step: StepFacts,
  templates: ReadonlySet<string>,
  issues: PlaybookIssue[],
): void {
  const { ownerRole, pointer } = step;
  if (ownerRole === undefined) return;
  if (ownerRole === 'any') {
    if (step.fallback === 'object') {
      issues.push({
        pointer: `${pointer}/fallback`,
        code: 'fallback_with_any',
        message: 'A step for any role has no fallback',
      });
    }
    if (step.altRoles.length > 0) {
      issues.push({
        pointer: `${pointer}/alt_roles`,
        code: 'alt_roles_with_any',
        message: 'A step for any role has no alt_roles',
      });
    }
    return;
  }
  if (step.fallback !== 'object') {
    issues.push({
      pointer: `${pointer}/fallback`,
      code: 'fallback_required',
      message: `A step of role "${ownerRole}" needs a fallback`,
    });
  } else if (step.template !== undefined && !templates.has(step.template)) {
    issues.push({
      pointer: `${pointer}/fallback/template`,
      code: 'unknown_template',
      message: `Template "${step.template}" is not in the platform template catalog`,
    });
  }
}

function checkSubmission(step: StepFacts, issues: PlaybookIssue[]): void {
  const { pointer } = step;
  if (step.type === 'artifact') {
    if (step.hasRitualKind) {
      issues.push({
        pointer: `${pointer}/ritual_kind`,
        code: 'ritual_kind_on_artifact',
        message: 'ritual_kind is only for a ritual',
      });
    }
    if (!step.hasSubmission) {
      issues.push({
        pointer: `${pointer}/submission`,
        code: 'submission_required',
        message: 'An artifact needs submission (link, file or either)',
      });
    }
  } else if (step.type === 'ritual') {
    if (step.hasSubmission) {
      issues.push({
        pointer: `${pointer}/submission`,
        code: 'submission_on_ritual',
        message: 'submission is only for an artifact',
      });
    }
    if (!step.hasRitualKind) {
      issues.push({
        pointer: `${pointer}/ritual_kind`,
        code: 'ritual_kind_required',
        message: 'A ritual needs ritual_kind',
      });
    }
  }
}

function checkReviewAndChecks(step: StepFacts, issues: PlaybookIssue[]): void {
  const { pointer } = step;
  if (step.reviewChecklist === true && step.reviewItems === 0) {
    issues.push({
      pointer: `${pointer}/review_items`,
      code: 'review_items_required',
      message: 'review_checklist is true, but there are no review_items',
    });
  } else if (step.reviewChecklist === false && step.reviewItems > 0) {
    issues.push({
      pointer: `${pointer}/review_items`,
      code: 'review_items_without_checklist',
      message: 'review_items are given, but review_checklist is false',
    });
  }
  step.autoChecks.forEach((check, k) => {
    const problem = checkAutoCheckKey(check);
    if (problem === null) return;
    issues.push({
      pointer: `${pointer}/auto_checks/${k}`,
      code: problem === 'unknown' ? 'unknown_check' : 'invalid_check_parameter',
      message:
        problem === 'unknown'
          ? `Check "${check}" is not in the auto check catalog`
          : `Check "${check}" has a wrong parameter (${problem})`,
    });
  });
}

function checkStages(stages: StageFacts[], issues: PlaybookIssue[]): void {
  checkDuplicates(stages, 'Stage', issues);
  checkDuplicates(
    stages.flatMap((stage) => stage.steps),
    'Step',
    issues,
  );
  for (const stage of stages) {
    const known = stage.steps.every((s) => s.type !== undefined && s.required !== undefined);
    const hasRequiredArtifact = stage.steps.some(
      (s) => s.type === 'artifact' && s.required === true,
    );
    if (known && stage.steps.length > 0 && !hasRequiredArtifact) {
      issues.push({
        pointer: `${stage.pointer}/steps`,
        code: 'no_required_artifact',
        message: 'A stage needs at least one required artifact',
      });
    }
  }
  const last = stages.at(-1);
  if (last !== undefined && last.steps.length > 0) {
    const releaseStep = last.steps.some(
      (s) =>
        s.required === true &&
        s.autoChecks.some((c) => RELEASE_AUTO_CHECKS.includes(autoCheckName(c))) &&
        s.autoChecks.some((c) => autoCheckName(c) === REPO_FINAL_CHECK),
    );
    if (!releaseStep) {
      issues.push({
        pointer: `${last.pointer}/steps`,
        code: 'release_step_missing',
        message:
          'The last stage needs a required step that checks the release (release_alive_*) and the repository (repo_final)',
      });
    }
  }
}

function checkTotal(
  file: Record<string, unknown>,
  stages: StageFacts[],
  result: RulesResult,
): void {
  const durations = stages.map((stage) => stage.durationDays);
  const total = file.total_days;
  if (typeof total !== 'number' || !Number.isInteger(total)) return;
  if (stages.length === 0 || !durations.every((d) => d !== undefined)) return;
  const sum = durations.reduce<number>((acc, d) => acc + (d ?? 0), 0);
  if (sum !== total) {
    result.errors.push({
      pointer: '/total_days',
      code: 'total_days_mismatch',
      message: `total_days is ${total}, the stages add up to ${sum}`,
    });
  }
  const weeks = sum / 7;
  if (weeks < MIN_PLAN_WEEKS || weeks > MAX_PLAN_WEEKS) {
    result.warnings.push({
      code: 'total_days_out_of_range',
      message: `The plan is ${sum} days (${Math.round(weeks * 10) / 10} weeks), outside ${MIN_PLAN_WEEKS}-${MAX_PLAN_WEEKS} weeks`,
    });
  }
}

export interface RulesResult {
  errors: PlaybookIssue[];
  warnings: PlaybookWarning[];
}

/**
 * Domain rules of FR-PLAY-02 over the parsed file. They run even when the structure has errors (on
 * whatever is readable), so one upload yields the full list instead of the first error.
 */
export function applyPlaybookRules(raw: unknown, catalogs: PlaybookCatalogs): RulesResult {
  const result: RulesResult = { errors: [], warnings: [] };
  const file = isRecord(raw) ? raw : {};
  const version = asString(file.version);
  if (version !== undefined && parseSemver(version) === null) {
    result.errors.push({
      pointer: '/version',
      code: 'invalid_version',
      message: 'version must be MAJOR.MINOR.PATCH (semver)',
    });
  }
  const rawStages: unknown[] = Array.isArray(file.stages) ? file.stages : [];
  const stages = rawStages.map((stage, i) => stageFacts(stage, `/stages/${i}`));
  for (const step of stages.flatMap((stage) => stage.steps)) {
    checkRoles(step, catalogs.roles, result.errors);
    checkFallback(step, catalogs.templates, result.errors);
    checkSubmission(step, result.errors);
    checkReviewAndChecks(step, result.errors);
  }
  checkStages(stages, result.errors);
  checkTotal(file, stages, result);
  return result;
}
