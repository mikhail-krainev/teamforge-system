import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { ORIGIN_HEADERS } from './api';
import { compose, ROOT } from './stack';
import { get, openSession, patch, post, put, signInWithGithub } from './slice4-world';
import type { Person, Session } from './slice3-world';

/**
 * State shared by the steps of the slice 5 scenario (the tests run serially in one worker).
 * Four people sign in through the GitHub double: `admin` publishes the playbook (through the API, like the
 * plan says), A leads the team, B holds Backend, C holds Frontend. The scenario file is the mini
 * playbook of the API tests (3 stages, apps/api/test/fixtures/playbooks/mini-playbook.yaml).
 */

export type PersonKey = 'admin' | 'a' | 'b' | 'c';

export const DISPLAY_NAMES: Record<PersonKey, string> = {
  admin: 'Админ Сценариев',
  a: 'Анна Лидова',
  b: 'Борис Бэкендов',
  c: 'Кирилл Фронтов',
};

export const world = {
  teamName: `Команда маршрута ${Date.now()}`,
  teamId: '',
  playbookId: '',
  /** `9.<seconds>.0`: greater than any version the stack has seen, a new one on every run. */
  version: `9.${Math.floor(Date.now() / 1000)}.0`,
  items: {} as Record<string, { id: string; version: number }>,
};

let people: Record<PersonKey, Person> | undefined;

export function setPeople(value: Record<PersonKey, Person> | undefined): void {
  people = value;
}

export function person(key: PersonKey): Person {
  if (!people) throw new Error('the people of the scenario are not signed in yet');
  return people[key];
}

export { get, openSession, patch, post, put, signInWithGithub };
export type { Person, Session };

export interface ChecklistItemBody {
  id: string;
  stepKey: string;
  status: 'open' | 'done';
  assigneeUserId: string | null;
  fallbackUsed: boolean;
  linkUrl?: string | null;
  linkStatus: 'none' | 'unchecked' | 'ok' | 'broken' | 'rejected';
  outcome?: string | null;
  files: { id: string; originalName: string }[];
  review?: { passed: boolean; answers: { ordinal: number; answer: boolean | null }[] } | null;
  version: number;
}

export interface StageBody {
  ordinal: number;
  key: string;
  status: 'pending' | 'open' | 'closed';
}

export function miniPlaybookText(): string {
  const file = path.join(ROOT, 'apps/api/test/fixtures/playbooks/mini-playbook.yaml');
  // the formatter writes the YAML with single quotes; the file has no apostrophes
  return readFileSync(file, 'utf8')
    .replaceAll("'", '"')
    .replace('version: "9.0.0"', `version: "${world.version}"`);
}

/** `POST /api/v1/admin/playbooks` takes the file text itself (`application/yaml`). */
export async function uploadPlaybookText(
  who: Person,
  text: string,
): Promise<{ status: number; body: { playbook: { id: string; status: string } }; text: string }> {
  const response = await who.session.context.request.post('/api/v1/admin/playbooks', {
    data: text,
    headers: {
      ...ORIGIN_HEADERS,
      'Content-Type': 'application/yaml',
      'Idempotency-Key': randomUUID(),
    },
  });
  const raw = await response.text();
  return { status: response.status(), body: JSON.parse(raw || '{}'), text: raw };
}

/** The administrators are issued outside the UI (FR-AUTH-08): the flag is set in the throwaway e2e database. */
export function makeAdmin(userId: string): void {
  const sql = `UPDATE auth."user" SET is_admin = true WHERE id = '${userId}'`;
  compose('exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'teamforge', '-c', sql);
}

/**
 * C-08 (24 hours on a stage) is too long for a test: the opening of the stage is moved 25 hours into
 * the past. Only the documented columns of `workspace.project_stage` are touched (architecture 5.7).
 */
export function backdateStage(teamId: string, ordinal: number): void {
  const sql =
    `UPDATE workspace.project_stage SET opened_at = opened_at - interval '25 hours', ` +
    `due_at = due_at - interval '25 hours' WHERE team_id = '${teamId}' AND ordinal = ${ordinal}`;
  compose('exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'teamforge', '-c', sql);
}

export async function checklist(who: Person, ordinal: number): Promise<ChecklistItemBody[]> {
  const response = await get<{ items: ChecklistItemBody[] }>(
    who,
    `/v1/teams/${world.teamId}/stages/${ordinal}/checklist`,
  );
  expect(response.status, response.text).toBe(200);
  return response.body.items;
}

export async function itemOf(
  who: Person,
  stepKey: string,
  ordinal = 1,
): Promise<ChecklistItemBody> {
  const found = (await checklist(who, ordinal)).find((i) => i.stepKey === stepKey);
  expect(found, `item ${stepKey}`).toBeDefined();
  return found as ChecklistItemBody;
}

export async function stages(who: Person): Promise<StageBody[]> {
  const response = await get<{ items: StageBody[] }>(who, `/v1/teams/${world.teamId}/stages`);
  expect(response.status, response.text).toBe(200);
  return response.body.items;
}

/** A write to an item through the API (setup that is not the step under test). */
export async function patchItem(
  who: Person,
  item: { id: string; version: number },
  body: Record<string, unknown>,
): Promise<ChecklistItemBody> {
  const response = await patch<ChecklistItemBody>(
    who.session.context.request,
    `/v1/teams/${world.teamId}/checklist-items/${item.id}`,
    { version: item.version, ...body },
  );
  expect(response.status, response.text).toBe(200);
  return response.body;
}

/** A minimal PDF-like file over 1 KiB for the upload input. */
export function artifactFile(name: string): { name: string; mimeType: string; buffer: Buffer } {
  const head = '%PDF-1.4\n1 0 obj<< /Type /Catalog >>endobj\n';
  const body = `% ${randomUUID()}\n${'%'.repeat(1500)}\n%%EOF\n`;
  return { name, mimeType: 'application/pdf', buffer: Buffer.from(head + body) };
}
