import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { expectMatchesContract } from '../helpers/contract.js';
import type { InjectResponse } from '../helpers/http.js';
import type { UserFixture } from './index.js';
import type { World } from './world.js';

/**
 * Slice 5 fixtures of the playbooks module (docs/plan.md S5-01): the mini playbook (3 stages, 28 days),
 * the broken files, the two real seeds and the HTTP helpers that publish a playbook as an administrator.
 * Everything goes over HTTP (uploadPlaybook, publishPlaybook), like production does (FR-PLAY-05).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'playbooks');
/** apps/api/seeds/playbooks: extracted from docs/playbooks.md 3.2 and 4.3 by S5-02 (not by this task). */
const SEED_DIR = path.join(HERE, '..', '..', 'seeds', 'playbooks');

/** Greater than the stubs `0.0.1` of slice 3 and the seeds `1.0.0`, so a test world publishes it as the latest. */
export const MINI_VERSION = '9.0.0';
export const MINI_TOTAL_DAYS = 28;
export const MINI_STAGE_KEYS = ['mini_s1', 'mini_s2', 'mini_s3'] as const;

export type BrokenName =
  | 'yaml-anchors'
  | 'yaml-bomb'
  | 'yaml-tags'
  | 'duplicate-map-key'
  | 'duplicate-keys'
  | 'unknown-role'
  | 'unknown-check'
  | 'many-errors';

export interface PlaybookSummaryDto {
  id: string;
  productTypeCode: string;
  title: string;
  version: string;
  status: 'draft' | 'published';
  totalDays: number;
  publishedAt?: string | null;
}

export interface PlaybookStepDto {
  key: string;
  title: string;
  description: string;
  type: 'artifact' | 'ritual';
  submission?: 'link' | 'file' | 'either' | null;
  ritualKind?: string | null;
  required: boolean;
  ownerRole: string;
  altRoles: string[];
  fallback: { title: string; instruction: string; template: string; url?: string | null } | null;
  reviewChecklist: boolean;
  reviewItems?: string[];
  autoChecks: string[];
  sources: string[];
}

export interface PlaybookStageDto {
  key: string;
  ordinal: number;
  title: string;
  goal: string;
  durationDays: number;
  exitCriteria: string;
  steps: PlaybookStepDto[];
}

export interface PlaybookDto extends PlaybookSummaryDto {
  stages: PlaybookStageDto[];
}

export interface UploadResultDto {
  playbook: PlaybookSummaryDto;
  warnings: { code: string; message: string }[];
}

export interface PageDto<T> {
  items: T[];
  nextCursor: string | null;
}

export interface TemplateDto {
  key: string;
  version: number;
  title: string;
  bodyMd: string;
}

export interface FieldErrorDto {
  pointer: string;
  code?: string;
  message: string;
}

export function readText(...parts: string[]): string {
  return readFileSync(path.join(...parts), 'utf8');
}

export interface MiniOverrides {
  version?: string;
  productType?: string;
  title?: string;
}

/** The mini playbook file with its version, product type and title replaced (all other text unchanged). */
export function miniPlaybookYaml(overrides: MiniOverrides = {}): string {
  // The repository formatter writes YAML with single quotes; the file has no apostrophes, so the
  // anchors of the rule tests (`version: "9.0.0"`, `auto_checks: ["file_ok", ...]`) stay literal.
  let text = readText(FIXTURE_DIR, 'mini-playbook.yaml').replaceAll("'", '"');
  if (overrides.version)
    text = replaceOnce(text, 'version: "9.0.0"', `version: "${overrides.version}"`);
  if (overrides.productType) {
    text = replaceOnce(text, 'product_type: web_service', `product_type: ${overrides.productType}`);
  }
  if (overrides.title)
    text = replaceOnce(text, 'title: "Мини-сценарий"', `title: "${overrides.title}"`);
  return text;
}

export function brokenPlaybookYaml(name: BrokenName): string {
  return readText(FIXTURE_DIR, 'broken', `${name}.yaml`);
}

/** A seed of the real scenarios (docs/playbooks.md 3.2 and 4.3); `total_days` 84 and 91. */
export function seedPlaybookYaml(name: 'web_service' | 'ml_product'): string {
  return readText(SEED_DIR, `${name}.yaml`);
}

/** Replaces exactly one occurrence; a missing or repeated anchor is a bug of the test, not of the system. */
export function replaceOnce(text: string, from: string, to: string): string {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`fixture anchor not found: ${from}`);
  if (text.indexOf(from, first + from.length) >= 0) {
    throw new Error(`fixture anchor is not unique: ${from}`);
  }
  return text.slice(0, first) + to + text.slice(first + from.length);
}

/** A mini playbook with one FR-PLAY-02 rule broken: `from` is replaced by `to` (exactly one place). */
export function miniMutated(from: string, to: string, overrides: MiniOverrides = {}): string {
  return replaceOnce(miniPlaybookYaml(overrides), from, to);
}

export interface SendOptions {
  contentType?: string;
  key?: string | null;
}

/** `uploadPlaybook`: the file text as the request body (`application/yaml` unless told otherwise). */
export function uploadPlaybookText(
  world: World,
  who: UserFixture,
  text: string,
  options: SendOptions = {},
): Promise<InjectResponse> {
  return world.as(who).request('POST', '/v1/admin/playbooks', text, {
    headers: { 'content-type': options.contentType ?? 'application/yaml' },
    ...(options.key === undefined ? {} : { idempotencyKey: options.key }),
  });
}

export function publishPlaybookAs(
  world: World,
  who: UserFixture,
  playbookId: string,
  options: SendOptions = {},
): Promise<InjectResponse> {
  return world.as(who).post(`/v1/admin/playbooks/${playbookId}/publication`, undefined, {
    ...(options.key === undefined ? {} : { idempotencyKey: options.key }),
  });
}

function okBody<T>(operationId: string, response: InjectResponse, status: number): T {
  expect(response.statusCode, `${operationId}: ${response.body}`).toBe(status);
  expectMatchesContract(operationId, response);
  return response.json<T>();
}

const admins = new WeakMap<World, Promise<UserFixture>>();

/** One administrator per world (the `is_admin` flag is set by SQL: admins are issued outside the UI, FR-AUTH-08). */
export function adminOf(world: World): Promise<UserFixture> {
  let admin = admins.get(world);
  if (!admin) {
    admin = world.createUser('playbook-admin', { admin: true });
    admins.set(world, admin);
  }
  return admin;
}

/** Uploads a file as a draft and publishes it; both answers are checked against the contract. */
export async function publishText(
  world: World,
  text: string,
): Promise<{ upload: UploadResultDto; published: PlaybookSummaryDto }> {
  const admin = await adminOf(world);
  const upload = okBody<UploadResultDto>(
    'uploadPlaybook',
    await uploadPlaybookText(world, admin, text),
    201,
  );
  const published = okBody<PlaybookSummaryDto>(
    'publishPlaybook',
    await publishPlaybookAs(world, admin, upload.playbook.id),
    200,
  );
  return { upload, published };
}

const minis = new WeakMap<World, Promise<PlaybookSummaryDto>>();

/**
 * Publishes the mini playbook (`web_service`, 9.0.0) once per world, so every team created afterwards
 * is pinned to it (FR-PLAY-03: new teams take the latest published version).
 */
export function publishMini(world: World): Promise<PlaybookSummaryDto> {
  let mini = minis.get(world);
  if (!mini) {
    mini = publishText(world, miniPlaybookYaml()).then((r) => r.published);
    minis.set(world, mini);
  }
  return mini;
}

export async function getPlaybookAs(
  world: World,
  who: UserFixture,
  playbookId: string,
): Promise<PlaybookDto> {
  return okBody<PlaybookDto>(
    'getPlaybook',
    await world.as(who).get(`/v1/playbooks/${playbookId}`),
    200,
  );
}
