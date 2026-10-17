import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { FakeClock } from '../helpers/clock.js';
import type { InjectResponse } from '../helpers/http.js';
import type { UploadFile } from './clients.js';
import { pdfFile } from './artifact-files.js';
import type { UserFixture } from './index.js';
import { publishMini, type PlaybookSummaryDto } from './playbooks.js';
import {
  DAY,
  expectOk,
  githubUser,
  joinThroughOffer,
  seatInput,
  team,
  teamInput,
  type TeamDto,
  type TeamFixture,
} from './teams.js';
import { PROFILE_STACK } from './profiles.js';
import { World as WorldClass, type World, type WorldOptions } from './world.js';

/**
 * Slice 5 fixtures of the workspace module (docs/plan.md S5-01): a started team on the mini playbook
 * (3 stages, `fixtures/playbooks/mini-playbook.yaml`) and the calls that fill its route. Everything
 * goes through the production path: publishPlaybook, createTeam, offers, startProject (T4 opens stage 1).
 */

export interface ArtifactFileDto {
  id: string;
  originalName: string;
  sizeBytes: number;
  mime: string;
  sha256: string;
  uploadedBy: string;
  createdAt: string;
}

export interface ReviewStateDto {
  reviewerUserId: string | null;
  answers: {
    ordinal: number;
    text: string;
    answer: boolean | null;
    acceptedRisk?: { reason: string; acceptedBy: string; at: string } | null;
  }[];
  passed: boolean;
}

export interface ChecklistItemDto {
  id: string;
  stageOrdinal: number;
  stepKey: string;
  title: string;
  kind: 'artifact' | 'ritual';
  submission?: 'link' | 'file' | 'either' | null;
  ritualKind?: string | null;
  required: boolean;
  ownerRole: string;
  status: 'open' | 'done';
  assigneeUserId: string | null;
  roleCode?: string | null;
  fallbackUsed: boolean;
  fallback?: { title: string; instruction: string; template: string; url?: string | null } | null;
  linkUrl?: string | null;
  linkStatus: 'none' | 'unchecked' | 'ok' | 'broken' | 'rejected';
  heldOn?: string | null;
  externalUrl?: string | null;
  outcome?: string | null;
  files: ArtifactFileDto[];
  review?: ReviewStateDto | null;
  version: number;
  updatedAt: string;
}

export interface ProjectStageDto {
  ordinal: number;
  key: string;
  title: string;
  status: 'pending' | 'open' | 'closed';
  durationDays: number;
  openedAt?: string | null;
  dueAt?: string | null;
  closedAt?: string | null;
  overdue: boolean;
}

export interface StageListDto {
  items: ProjectStageDto[];
  plannedEndAt?: string | null;
}

export interface UnmetDto {
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

/** A started team on the mini playbook: lead (no role), `backend` and `frontend` members; no `pm`, `ba`, `qa`. */
export interface RouteFixture {
  world: World;
  team: TeamFixture;
  lead: UserFixture;
  backend: UserFixture;
  frontend: UserFixture;
  playbook: PlaybookSummaryDto;
}

export function clockOf(world: World): FakeClock {
  const clock = world.options.clock;
  if (!clock) throw new Error('this scenario needs World.start({ clock })');
  return clock;
}

/** `YYYY-MM-DD` of the world clock (FR-WORK-06: the day a ritual was held). */
export function today(world: World): string {
  return clockOf(world).now().toISOString().slice(0, 10);
}

/**
 * `route()` of the plan: publishes the mini playbook (once per world), builds a team of `members`
 * people (lead included) whose members hold `backend`, `frontend`, ... and starts the project.
 * The world needs a FakeClock when the scenario moves time (24 h on a stage, C-08).
 */
export async function routeTeam(
  world: World,
  options: { members?: number; started?: boolean; openRole?: string } = {},
): Promise<RouteFixture> {
  const playbook = await publishMini(world);
  const built = await team(world, {
    members: options.members ?? 3,
    openSeats: 1,
    roleCode: options.openRole ?? 'devops',
    joinPlannedRoles: true,
    status: options.started === false ? 'forming' : 'active',
  });
  const [backend, frontend] = built.members;
  if (!backend) throw new Error('routeTeam needs at least two members (lead + backend)');
  return {
    world,
    team: built,
    lead: built.lead,
    backend,
    frontend: frontend ?? backend,
    playbook,
  };
}

export async function stagesOf(
  world: World,
  who: UserFixture,
  teamId: string,
): Promise<StageListDto> {
  return expectOk<StageListDto>(
    'listStages',
    await world.as(who).get(`/v1/teams/${teamId}/stages`),
    200,
  );
}

export async function checklistOf(
  world: World,
  who: UserFixture,
  teamId: string,
  ordinal: number,
): Promise<ChecklistItemDto[]> {
  const body = expectOk<{ items: ChecklistItemDto[] }>(
    'getStageChecklist',
    await world.as(who).get(`/v1/teams/${teamId}/stages/${ordinal}/checklist`),
    200,
  );
  return body.items;
}

/** The current state of one item by its step key (the contract has no single-item read). */
export async function itemOf(
  fx: RouteFixture,
  stepKey: string,
  ordinal = 1,
  viewer: UserFixture = fx.lead,
): Promise<ChecklistItemDto> {
  const found = (await checklistOf(fx.world, viewer, fx.team.id, ordinal)).find(
    (i) => i.stepKey === stepKey,
  );
  if (!found) throw new Error(`no item ${stepKey} on stage ${ordinal}`);
  return found;
}

export interface WriteOptions {
  key?: string | null;
}

export function patchItem(
  world: World,
  who: UserFixture,
  teamId: string,
  itemId: string,
  body: Record<string, unknown>,
  options: WriteOptions = {},
): Promise<InjectResponse> {
  return world.as(who).patch(`/v1/teams/${teamId}/checklist-items/${itemId}`, body, {
    ...(options.key === undefined ? {} : { idempotencyKey: options.key }),
  });
}

export function uploadFile(
  world: World,
  who: UserFixture,
  teamId: string,
  itemId: string,
  file: UploadFile = pdfFile(),
  options: WriteOptions = {},
): Promise<InjectResponse> {
  return world.as(who).upload(`/v1/teams/${teamId}/checklist-items/${itemId}/files`, file, {
    ...(options.key === undefined ? {} : { idempotencyKey: options.key }),
  });
}

export function transition(
  world: World,
  who: UserFixture,
  teamId: string,
  fromOrdinal: number,
  options: WriteOptions = {},
): Promise<InjectResponse> {
  return world.as(who).post(
    `/v1/teams/${teamId}/stage-transitions`,
    { fromOrdinal },
    {
      ...(options.key === undefined ? {} : { idempotencyKey: options.key }),
    },
  );
}

export function submitReview(
  world: World,
  who: UserFixture,
  teamId: string,
  item: Pick<ChecklistItemDto, 'id' | 'version'>,
  answers: { ordinal: number; answer: boolean }[],
): Promise<InjectResponse> {
  return world.as(who).put(`/v1/teams/${teamId}/checklist-items/${item.id}/review`, {
    version: item.version,
    answers,
  });
}

export function acceptRisk(
  world: World,
  who: UserFixture,
  teamId: string,
  item: Pick<ChecklistItemDto, 'id' | 'version'>,
  ordinal: number,
  reason = 'Риск принят командой, исправим на следующем этапе',
): Promise<InjectResponse> {
  return world
    .as(who)
    .post(`/v1/teams/${teamId}/checklist-items/${item.id}/review/risk-acceptances`, {
      version: item.version,
      ordinal,
      reason,
    });
}

export function assign(
  world: World,
  who: UserFixture,
  teamId: string,
  item: Pick<ChecklistItemDto, 'id' | 'version'>,
  userId: string,
): Promise<InjectResponse> {
  return world.as(who).put(`/v1/teams/${teamId}/checklist-items/${item.id}/assignee`, {
    version: item.version,
    userId,
  });
}

/** A ritual closed with the three obligatory fields (FR-WORK-06). */
export function ritualFields(world: World): Record<string, unknown> {
  return {
    heldOn: today(world),
    externalUrl: 'https://meet.example.test/room-1',
    outcome: 'Договорились о цели проекта, ролях и правилах работы команды.',
  };
}

/** `PATCH status=done` with the current version; the answer must be 200. */
export async function markDone(
  fx: RouteFixture,
  stepKey: string,
  who: UserFixture,
  ordinal = 1,
  extra: Record<string, unknown> = {},
): Promise<ChecklistItemDto> {
  const item = await itemOf(fx, stepKey, ordinal, who);
  return expectOk<ChecklistItemDto>(
    'updateChecklistItem',
    await patchItem(fx.world, who, fx.team.id, item.id, {
      version: item.version,
      status: 'done',
      ...extra,
    }),
    200,
  );
}

/** Saves a link (FR-WORK-04) and closes the item. */
export async function doneWithLink(
  fx: RouteFixture,
  stepKey: string,
  who: UserFixture,
  ordinal = 1,
  url = 'https://example.test/board',
): Promise<ChecklistItemDto> {
  const item = await itemOf(fx, stepKey, ordinal, who);
  const saved = expectOk<ChecklistItemDto>(
    'updateChecklistItem',
    await patchItem(fx.world, who, fx.team.id, item.id, { version: item.version, linkUrl: url }),
    200,
  );
  return expectOk<ChecklistItemDto>(
    'updateChecklistItem',
    await patchItem(fx.world, who, fx.team.id, saved.id, {
      version: saved.version,
      status: 'done',
    }),
    200,
  );
}

/** Uploads a file (FR-WORK-05; it raises the item version) and closes the item. */
export async function doneWithFile(
  fx: RouteFixture,
  stepKey: string,
  who: UserFixture,
  ordinal = 1,
  file: UploadFile = pdfFile(),
): Promise<ChecklistItemDto> {
  const item = await itemOf(fx, stepKey, ordinal, who);
  expectOk('uploadArtifactFile', await uploadFile(fx.world, who, fx.team.id, item.id, file), 201);
  return markDone(fx, stepKey, who, ordinal);
}

export async function doneRitual(
  fx: RouteFixture,
  stepKey: string,
  who: UserFixture,
  ordinal = 1,
): Promise<ChecklistItemDto> {
  return markDone(fx, stepKey, who, ordinal, ritualFields(fx.world));
}

/** The reviewer (never the author, FR-WORK-09) answers "yes" to every point of the item's checklist. */
export async function passReview(
  fx: RouteFixture,
  stepKey: string,
  reviewer: UserFixture,
  ordinal = 1,
): Promise<ChecklistItemDto> {
  const item = await itemOf(fx, stepKey, ordinal, reviewer);
  const ordinals = (item.review?.answers ?? []).map((a) => a.ordinal);
  const answers = (ordinals.length > 0 ? ordinals : [1, 2, 3]).map((ordinal) => ({
    ordinal,
    answer: true,
  }));
  return expectOk<ChecklistItemDto>(
    'submitReview',
    await submitReview(fx.world, reviewer, fx.team.id, item, answers),
    200,
  );
}

/**
 * Every obligatory item of stage 1 of the mini playbook is done and reviewed:
 * kickoff (any member), board (link), charter (no `pm`/`ba` in the team: fallback, the lead assigns
 * the frontend member), spec (backend, reviewed by the frontend member).
 */
export async function completeStageOne(fx: RouteFixture): Promise<void> {
  await doneRitual(fx, 'mini_kickoff', fx.frontend);
  await doneWithLink(fx, 'mini_board', fx.backend);
  const charter = await itemOf(fx, 'mini_charter');
  expectOk<ChecklistItemDto>(
    'assignChecklistItem',
    await assign(fx.world, fx.lead, fx.team.id, charter, fx.frontend.id),
    200,
  );
  await doneWithFile(fx, 'mini_charter', fx.frontend);
  await doneWithFile(fx, 'mini_spec', fx.backend);
  await passReview(fx, 'mini_spec', fx.frontend);
}

/** Obligatory items of stage 2: design (frontend) and the retrospective. */
export async function completeStageTwo(fx: RouteFixture): Promise<void> {
  await doneWithFile(fx, 'mini_design', fx.frontend, 2);
  await doneRitual(fx, 'mini_retro', fx.backend, 2);
}

/** C-08: at least 24 hours on a stage. */
export function waitMinimumStageTime(world: World): void {
  clockOf(world).advance(DAY + 60_000);
}

/** The lead closes stage `from`: 24 h pass first; the answer must be 201. */
export async function advanceStage(
  fx: RouteFixture,
  from: number,
): Promise<{ closedOrdinal: number; openedOrdinal: number | null }> {
  waitMinimumStageTime(fx.world);
  return expectOk('transitionStage', await transition(fx.world, fx.lead, fx.team.id, from), 201);
}

export const newKey = (): string => randomUUID();

/** The ids a foreign-team probe needs: one item of stage 1 by step key. */
export async function itemIdOf(fx: RouteFixture, stepKey: string, ordinal = 1): Promise<string> {
  return (await itemOf(fx, stepKey, ordinal)).id;
}

export function expectNoUnmet(response: InjectResponse): void {
  expect(response.json<{ unmet?: unknown[] }>().unmet ?? []).toEqual([]);
}

export interface RolesFixture {
  teamId: string;
  lead: UserFixture;
  /** `holders[i]` holds `roles[i]`. */
  holders: UserFixture[];
}

/**
 * A started team whose members hold exactly `roles` (one seat per role, filled through offers): the
 * cases of FR-WORK-02 (one holder, several holders, only an alternative role, nobody).
 */
export async function startedTeamWithRoles(world: World, roles: string[]): Promise<RolesFixture> {
  await publishMini(world);
  const lead = await githubUser(world, 'roles-lead');
  const created = expectOk<TeamDto>(
    'createTeam',
    await world
      .as(lead)
      .post('/v1/teams', teamInput({ seats: roles.map((roleCode) => seatInput({ roleCode })) })),
    201,
  );
  const holders: UserFixture[] = [];
  for (const [i, seat] of created.seats.entries()) {
    const holder = await githubUser(world, `${roles[i] ?? 'holder'}-${i}`);
    await joinThroughOffer(world, lead, created.id, seat.id, holder);
    holders.push(holder);
  }
  expectOk('startProject', await world.as(lead).post(`/v1/teams/${created.id}/start`), 200);
  return { teamId: created.id, lead, holders };
}

/** Roles of the mini playbook and the catalog roles teams are built from; `World.ensureCatalog` is idempotent. */
export const ROUTE_ROLES = ['pm', 'ba', 'backend', 'frontend', 'qa', 'designer', 'devops'];

/** A world for the slice 5 scenarios: the catalog is ready, the mini playbook is published on first use of `routeTeam`. */
export async function startRouteWorld(options: WorldOptions = {}): Promise<World> {
  const started = await WorldClass.start(options);
  await started.ensureCatalog(ROUTE_ROLES, PROFILE_STACK);
  return started;
}
