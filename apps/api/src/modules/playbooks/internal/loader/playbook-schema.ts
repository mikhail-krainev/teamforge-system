import { z } from 'zod';
import { pointerOf, type PlaybookIssue } from './issue.js';

/** Keys of products, stages, steps: lower case, digits and underscores. */
export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const PRODUCT_TYPE_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
const ROLE_OR_ANY = /^[a-z][a-z0-9_]{0,39}$/;
const TEMPLATE_KEY = /^tpl_[a-z0-9_]{1,60}$/;

const MAX_STAGES = 30;
const MAX_STEPS_PER_STAGE = 60;
const MAX_LIST = 50;

const text = (max: number) => z.string().trim().min(1).max(max);
const key = z
  .string()
  .regex(KEY_PATTERN, 'Lower case letters, digits and "_", starting with a letter');
const httpsUrl = z
  .string()
  .max(2048)
  .refine((value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol), {
    message: 'Must be an absolute http(s) URL',
  });

const fallbackSchema = z.strictObject({
  title: text(200),
  instruction: text(2000),
  template: z.string().regex(TEMPLATE_KEY, 'Must be a platform template key (tpl_...)'),
  url: httpsUrl.nullish(),
});

const stepSchema = z.strictObject({
  key,
  title: text(200),
  description: text(4000),
  type: z.enum(['artifact', 'ritual']),
  submission: z.enum(['link', 'file', 'either']).optional(),
  ritual_kind: z.enum(['call', 'retro', 'brainstorm', 'code_review']).optional(),
  required: z.boolean(),
  owner_role: z.string().regex(ROLE_OR_ANY, 'A role key or "any"'),
  alt_roles: z.array(z.string().regex(ROLE_OR_ANY)).max(MAX_LIST).optional(),
  fallback: fallbackSchema.nullish(),
  review_checklist: z.boolean(),
  review_items: z.array(text(500)).max(MAX_LIST).optional(),
  auto_checks: z.array(z.string().min(1).max(64)).max(MAX_LIST).optional(),
  sources: z.array(httpsUrl).min(1, 'At least one source is required').max(MAX_LIST),
});

const stageSchema = z.strictObject({
  key,
  title: text(200),
  goal: text(2000),
  duration_days: z.int().positive().max(365),
  exit_criteria: text(2000),
  steps: z.array(stepSchema).min(1).max(MAX_STEPS_PER_STAGE),
});

/** Structure of a playbook file (docs/playbooks.md 2.1). Unknown fields are refused. */
export const playbookFileSchema = z.strictObject({
  product_type: z.string().regex(PRODUCT_TYPE_PATTERN, 'Lower case letters, digits and "_"'),
  title: text(200),
  version: z.string(),
  total_days: z.int().positive(),
  stages: z.array(stageSchema).min(1).max(MAX_STAGES),
});

export type PlaybookFile = z.infer<typeof playbookFileSchema>;
export type PlaybookFileStep = z.infer<typeof stepSchema>;

/** Structural findings of zod as list entries; an unrecognized key is pointed at, not only its parent. */
export function structureIssues(error: z.ZodError): PlaybookIssue[] {
  const issues: PlaybookIssue[] = [];
  for (const item of error.issues) {
    if (item.code === 'unrecognized_keys') {
      for (const name of item.keys) {
        issues.push({
          pointer: pointerOf([...item.path, name]),
          code: 'unknown_field',
          message: `Unknown field "${name}"`,
        });
      }
    } else {
      issues.push({ pointer: pointerOf(item.path), code: item.code, message: item.message });
    }
  }
  return issues;
}
