import { z } from 'zod';

/*
 * Payloads of the events the worker uses (architecture 7.3 item 4). Only the fields it reads are
 * described: GitHub adds fields all the time and they are dropped by `z.object`; the fields it
 * relies on are required, so a payload of another shape is refused instead of half-applied (SEC-06).
 */

const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'not a timestamp');
const nullableTimestamp = timestamp.nullish();
const githubId = z.number().int().positive();

const account = z.object({ id: githubId });
const installationRef = z.object({ id: githubId });
const repositoryRef = z.object({ id: githubId, full_name: z.string().min(1) });
const label = z.object({ name: z.string() });

const common = {
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string(),
  state: z.enum(['open', 'closed']),
  user: account.nullish(),
  assignees: z.array(account).default([]),
  labels: z.array(label).default([]),
  updated_at: timestamp,
  closed_at: nullableTimestamp,
};

export const issueObject = z.object(common);

export const pullRequestObject = z.object({
  ...common,
  body: z.string().nullish(),
  merged: z.boolean().default(false),
  merged_at: nullableTimestamp,
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
});

export const issuesEvent = z.object({
  action: z.string(),
  issue: issueObject,
  repository: repositoryRef,
  installation: installationRef,
});

export const pullRequestEvent = z.object({
  action: z.string(),
  pull_request: pullRequestObject,
  repository: repositoryRef,
  installation: installationRef,
});

export const reviewEvent = z.object({
  action: z.string(),
  review: z.object({
    user: account.nullable(),
    state: z.string().min(1),
    submitted_at: timestamp.nullish(),
  }),
  pull_request: z.object({ number: z.number().int().positive() }),
  repository: repositoryRef,
  installation: installationRef,
});

export const installationEvent = z.object({
  action: z.string(),
  installation: installationRef,
});

export const installationRepositoriesEvent = z.object({
  action: z.string(),
  installation: installationRef,
  repositories_removed: z.array(z.object({ id: githubId })).default([]),
});

export const repositoryEvent = z.object({
  action: z.string(),
  repository: repositoryRef,
  installation: installationRef,
});

export type IssueObject = z.infer<typeof issueObject>;
export type PullRequestObject = z.infer<typeof pullRequestObject>;
export type IssuesEvent = z.infer<typeof issuesEvent>;
export type PullRequestEvent = z.infer<typeof pullRequestEvent>;
export type ReviewEvent = z.infer<typeof reviewEvent>;
export type InstallationEvent = z.infer<typeof installationEvent>;
export type InstallationRepositoriesEvent = z.infer<typeof installationRepositoriesEvent>;
export type RepositoryEvent = z.infer<typeof repositoryEvent>;

/** What the receiver reads before it knows the event: the envelope fields, each optional. */
export interface Envelope {
  action: string | null;
  installationId: number | null;
  repositoryId: number | null;
  /** `installation_repositories.removed`: the repositories the delivery is about. */
  removedRepositoryIds: number[];
}

const positiveInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Lenient reading of the envelope of a signed JSON object; anything unexpected is `null`. */
export function readEnvelope(payload: Record<string, unknown>): Envelope {
  const removed = Array.isArray(payload['repositories_removed'])
    ? payload['repositories_removed'].flatMap((entry: unknown) => {
        const id = positiveInt(record(entry)?.['id']);
        return id === null ? [] : [id];
      })
    : [];
  return {
    action: typeof payload['action'] === 'string' ? payload['action'] : null,
    installationId: positiveInt(record(payload['installation'])?.['id']),
    repositoryId: positiveInt(record(payload['repository'])?.['id']),
    removedRepositoryIds: removed,
  };
}
