import { createHmac, randomUUID } from 'node:crypto';

/**
 * Webhook side of the GitHub double (docs/plan.md S6-02; architecture 7.3). Pure functions: they build
 * the payloads GitHub sends (field names of docs.github.com) and sign them like GitHub does
 * (`X-Hub-Signature-256: sha256=<hex HMAC of the RAW body>`). Nothing here talks to the network: a test
 * hands the request to a "sink" (Fastify `inject` in API tests, HTTP in Playwright).
 */

export interface TwinPerson {
  id: number;
  login: string;
}

export interface WebhookRequest {
  headers: Record<string, string>;
  /** The raw body the signature is computed over (a string: re-serialising it would change the bytes). */
  body: string;
}

/** Delivers a webhook request to the application and says what the application answered. */
export type WebhookSink = (request: WebhookRequest) => Promise<{ status: number }>;

/**
 * How the signature header of a delivery is produced:
 *  - valid: correct secret, raw body as sent;
 *  - invalid: right shape, wrong digest;
 *  - missing: no header at all;
 *  - malformed: not `sha256=<64 hex>` (FR-GH-03 treats it as an invalid signature);
 *  - wrong-secret: HMAC of the same body under another secret (a delivery signed by somebody else);
 *  - sha1: the legacy header name only (X-Hub-Signature), the new one absent;
 *  - padded: valid digest with spaces around it;
 *  - tampered: valid digest of the original body, but the body is changed afterwards (raw-body check);
 *  - upper-digest: the right digest written in capitals (GitHub writes lower case);
 *  - upper-prefix: `SHA256=` in capitals in front of the right digest;
 *  - inner-space: `sha256= <digest>` (a space after the equals sign);
 *  - short: the digest cut to 63 characters;
 *  - empty: the header is present and empty;
 *  - tab: valid digest followed by a tab;
 *  - sha1-too: the right sha256 header plus a legacy `X-Hub-Signature` that is wrong (the new header decides).
 */
export type SignatureMode =
  | 'valid'
  | 'invalid'
  | 'missing'
  | 'malformed'
  | 'wrong-secret'
  | 'sha1'
  | 'padded'
  | 'tampered'
  | 'upper-digest'
  | 'upper-prefix'
  | 'inner-space'
  | 'short'
  | 'empty'
  | 'tab'
  | 'sha1-too';

export interface WebhookOptions {
  /** `X-GitHub-Delivery`; random by default. A repeated id is a re-delivery. */
  deliveryId?: string;
  signature?: SignatureMode;
  /** The secret the application holds (the double's `webhookSecret`). */
  secret: string;
}

export const hmacHex = (secret: string, body: string): string =>
  createHmac('sha256', secret).update(body).digest('hex');

/** Headers + raw body of one delivery. */
export function buildWebhook(
  event: string,
  payload: unknown,
  options: WebhookOptions,
): WebhookRequest {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'GitHub-Hookshot/double',
    'x-github-event': event,
    'x-github-delivery': options.deliveryId ?? randomUUID(),
  };
  const mode = options.signature ?? 'valid';
  const digest = hmacHex(options.secret, body);
  switch (mode) {
    case 'valid':
      headers['x-hub-signature-256'] = `sha256=${digest}`;
      break;
    case 'invalid':
      headers['x-hub-signature-256'] =
        `sha256=${digest.replace(/./, (c) => (c === '0' ? '1' : '0'))}`;
      break;
    case 'malformed':
      headers['x-hub-signature-256'] = digest;
      break;
    case 'wrong-secret':
      headers['x-hub-signature-256'] = `sha256=${hmacHex(`${options.secret}-other`, body)}`;
      break;
    case 'sha1':
      headers['x-hub-signature'] =
        `sha1=${createHmac('sha1', options.secret).update(body).digest('hex')}`;
      break;
    case 'padded':
      headers['x-hub-signature-256'] = ` sha256=${digest} `;
      break;
    case 'tampered':
      headers['x-hub-signature-256'] = `sha256=${digest}`;
      return { headers, body: `${body.slice(0, -1)} }` };
    case 'upper-digest':
      headers['x-hub-signature-256'] = `sha256=${digest.toUpperCase()}`;
      break;
    case 'upper-prefix':
      headers['x-hub-signature-256'] = `SHA256=${digest}`;
      break;
    case 'inner-space':
      headers['x-hub-signature-256'] = `sha256= ${digest}`;
      break;
    case 'short':
      headers['x-hub-signature-256'] = `sha256=${digest.slice(0, 63)}`;
      break;
    case 'empty':
      headers['x-hub-signature-256'] = '';
      break;
    case 'tab':
      headers['x-hub-signature-256'] = `sha256=${digest}\t`;
      break;
    case 'sha1-too':
      headers['x-hub-signature-256'] = `sha256=${digest}`;
      headers['x-hub-signature'] = `sha1=${'0'.repeat(40)}`;
      break;
    case 'missing':
      break;
  }
  return { headers, body };
}

// ---- payload builders ----------------------------------------------------------------------------

export interface PayloadRepo {
  id: number;
  fullName: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  createdAt: string;
  ownerId: number;
  ownerLogin: string;
}

export interface PayloadItem {
  number: number;
  kind: 'issue' | 'pr';
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  author: TwinPerson;
  assignees: TwinPerson[];
  labels: string[];
  body: string;
  additions: number;
  deletions: number;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  createdAt: string;
}

const person = (p: TwinPerson): Record<string, unknown> => ({
  id: p.id,
  login: p.login,
  type: 'User',
});

export function repositoryPayload(repo: PayloadRepo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.fullName.split('/')[1],
    full_name: repo.fullName,
    private: repo.private,
    fork: repo.fork,
    archived: repo.archived,
    created_at: repo.createdAt,
    owner: { id: repo.ownerId, login: repo.ownerLogin, type: 'User' },
    html_url: `https://github.com/${repo.fullName}`,
  };
}

/** The `issue` (or `pull_request`) object as it appears in webhooks and in REST lists. */
export function itemObject(repo: PayloadRepo, item: PayloadItem): Record<string, unknown> {
  const base = {
    id: repo.id * 1000 + item.number,
    number: item.number,
    title: item.title,
    html_url: `https://github.com/${repo.fullName}/${item.kind === 'pr' ? 'pull' : 'issues'}/${item.number}`,
    state: item.state,
    user: person(item.author),
    assignees: item.assignees.map(person),
    assignee: item.assignees[0] ? person(item.assignees[0]) : null,
    labels: item.labels.map((name) => ({ name })),
    body: item.body,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    closed_at: item.closedAt,
  };
  if (item.kind === 'issue') {
    return { ...base, state_reason: item.state === 'closed' ? 'completed' : null };
  }
  return {
    ...base,
    merged: item.merged,
    merged_at: item.mergedAt,
    additions: item.additions,
    deletions: item.deletions,
    draft: false,
    head: { ref: 'feature' },
    base: { ref: 'main' },
  };
}

export type IssueAction =
  'opened' | 'closed' | 'reopened' | 'edited' | 'assigned' | 'deleted' | 'transferred';
export type PullAction = 'opened' | 'closed' | 'reopened' | 'edited' | 'synchronize';

export function issuesPayload(
  action: IssueAction,
  repo: PayloadRepo,
  item: PayloadItem,
  installationId: number,
  sender: TwinPerson,
): Record<string, unknown> {
  return {
    action,
    issue: itemObject(repo, item),
    repository: repositoryPayload(repo),
    installation: { id: installationId },
    sender: person(sender),
  };
}

export function pullRequestPayload(
  action: PullAction,
  repo: PayloadRepo,
  item: PayloadItem,
  installationId: number,
  sender: TwinPerson,
): Record<string, unknown> {
  return {
    action,
    number: item.number,
    pull_request: itemObject(repo, item),
    repository: repositoryPayload(repo),
    installation: { id: installationId },
    sender: person(sender),
  };
}

export function reviewPayload(
  repo: PayloadRepo,
  item: PayloadItem,
  review: {
    reviewer: TwinPerson;
    state: 'approved' | 'changes_requested' | 'commented';
    submittedAt: string;
  },
  installationId: number,
): Record<string, unknown> {
  return {
    action: 'submitted',
    review: {
      id: repo.id * 7 + item.number,
      user: person(review.reviewer),
      state: review.state,
      submitted_at: review.submittedAt,
    },
    pull_request: itemObject(repo, item),
    repository: repositoryPayload(repo),
    installation: { id: installationId },
    sender: person(review.reviewer),
  };
}

export function installationPayload(
  action: 'created' | 'deleted' | 'suspend' | 'unsuspend',
  installation: { id: number; accountId: number; accountLogin: string },
  sender: TwinPerson,
): Record<string, unknown> {
  return {
    action,
    installation: {
      id: installation.id,
      account: { id: installation.accountId, login: installation.accountLogin, type: 'User' },
    },
    sender: person(sender),
  };
}

export function installationRepositoriesPayload(
  action: 'added' | 'removed',
  installationId: number,
  repos: PayloadRepo[],
  sender: TwinPerson,
): Record<string, unknown> {
  const list = repos.map((r) => ({ id: r.id, full_name: r.fullName, private: r.private }));
  return {
    action,
    installation: { id: installationId },
    repositories_added: action === 'added' ? list : [],
    repositories_removed: action === 'removed' ? list : [],
    sender: person(sender),
  };
}

export function repositoryEventPayload(
  action: 'archived' | 'deleted' | 'privatized' | 'renamed' | 'transferred',
  repo: PayloadRepo,
  installationId: number,
  sender: TwinPerson,
): Record<string, unknown> {
  return {
    action,
    repository: repositoryPayload(repo),
    installation: { id: installationId },
    sender: person(sender),
  };
}
