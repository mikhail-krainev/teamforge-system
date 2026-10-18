import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { PayloadItem, PayloadRepo, TwinPerson } from './github-webhooks.js';

/** Types and small helpers of the GitHub App double (see `github-app.ts`). */

export type Permissions = Record<string, 'read' | 'write'>;
export const ALL_READ: Permissions = {
  metadata: 'read',
  issues: 'read',
  pull_requests: 'read',
  actions: 'read',
};

export const HOUR_MS = 3_600_000;
export const JWT_MAX_LIFETIME_SECONDS = 600;
export const DEFAULT_QUOTA = 5000;
export const PAGE_MAX = 100;

export interface AppClock {
  now(): Date;
}

export interface TwinAccount {
  id: number;
  login: string;
  type: 'User' | 'Organization';
  /** GitHub ids of the people who may install the App on this account (for a User: the user itself). */
  ownerIds?: number[];
  createdAt?: string;
  publicRepos?: number;
  /** Public events of the account (FR-GH-09: activity instead of public repositories). */
  publicEvents?: number;
}

export interface TwinInstallation {
  id: number;
  account: TwinAccount;
  permissions: Permissions;
  repositorySelection: 'all' | 'selected';
  suspendedAt: string | null;
  deleted: boolean;
}

export interface TwinContributor extends TwinPerson {
  contributions: number;
}

export interface TwinRepo extends PayloadRepo {
  installationId: number;
  defaultBranch: string;
  contributors: TwinContributor[];
  /** Repository removed from the installation (installation_repositories.removed) or deleted. */
  gone: boolean;
}

export interface RepoSpec {
  name: string;
  private?: boolean;
  fork?: boolean;
  archived?: boolean;
  createdAt?: string;
  contributors?: TwinContributor[];
}

export interface TwinItem extends PayloadItem {
  repoId: number;
  /** A deleted or transferred issue: not listed, direct reads answer 404. */
  gone: boolean;
  reviews: {
    reviewer: TwinPerson;
    state: 'approved' | 'changes_requested' | 'commented';
    submittedAt: string;
  }[];
}

export interface ItemSpec {
  title?: string;
  author: TwinPerson;
  assignees?: TwinPerson[];
  labels?: string[];
  body?: string;
  additions?: number;
  deletions?: number;
  at?: Date;
}

export interface WorkflowRun {
  id: number;
  conclusion: 'success' | 'failure' | 'cancelled' | null;
  headBranch: string;
  createdAt: string;
}

export interface TwinCall {
  method: string;
  path: string;
  query: Record<string, string>;
  /** What the request authenticated with: an App JWT, an installation token, a user token or nothing. */
  auth: 'app-jwt' | 'installation-token' | 'user-token' | 'none';
  /** Installation of the token (installation tokens only). */
  installationId: number | undefined;
  status: number;
}

export interface InstallResult {
  /** Query of the redirect to Callback URL #1 of the App: pass it to `GET /v1/github/setup`. */
  query: Record<string, string>;
  installation: TwinInstallation | undefined;
}

export interface InstallOptions {
  state: string;
  /** GitHub does not echo `state` (the fallback case of the S6-01 prototype). */
  dropState?: boolean;
  /** Repositories to create with the installation (only when the installation is new). */
  repos?: RepoSpec[];
  permissions?: Permissions;
  repositorySelection?: 'all' | 'selected';
}

export interface ThrottleOptions {
  /** 403 (secondary limit, default) or 429. */
  status?: 403 | 429;
  retryAfterSeconds: number;
}

export interface TokenRecord {
  installationId: number;
  expiresAt: number;
}

export interface IdentityLike {
  id: number;
  login: string;
}

export interface GithubAppOptions {
  appId?: number;
  slug?: string;
  webhookSecret?: string;
  /** PKCS#1 private key of the App; generated once per process when absent. */
  privateKeyPem?: string;
  clock?: AppClock;
  /** Mints a code for the user-to-server exchange (`GithubServer` owns the codes). */
  issueCode(identity: IdentityLike, redirectUri: string): string;
  baseUrl(): string;
}

let sharedKey: { privateKeyPem: string; publicKey: KeyObject } | undefined;

/** One 2048-bit key for the whole test process (generation costs ~100 ms). */
export function processKey(): NonNullable<typeof sharedKey> {
  if (!sharedKey) {
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    sharedKey = { privateKeyPem: pair.privateKey, publicKey: createPublicKey(pair.publicKey) };
  }
  return sharedKey;
}

export const iso = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

export const sendJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
};

export function paginate<T>(
  list: T[],
  query: Record<string, string>,
  url: URL,
): { items: T[]; headers: Record<string, string> } {
  const perPage = Math.min(Math.max(Number(query.per_page ?? 30) || 30, 1), PAGE_MAX);
  const page = Math.max(Number(query.page ?? 1) || 1, 1);
  const items = list.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < list.length) {
    const next = new URL(url);
    next.searchParams.set('page', String(page + 1));
    headers.link = `<${next.toString()}>; rel="next"`;
  }
  return { items, headers };
}
