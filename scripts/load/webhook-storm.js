// CC-11 under load (FR-GH-03, FR-GH-04): signed GitHub deliveries, each one sent N times at once under the same
// X-GitHub-Delivery. Invariant: every copy is answered 202, and verify.mjs finds exactly one row of
// webhook_delivery per delivery id and one contribution per relevant delivery. Even deliveries belong to the
// linked repository (queued and processed), odd ones to an unknown repository (stored as ignored).
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { hmac } from 'k6/crypto';
import { BASE, fixture, thresholds, violations } from './common.js';

const DELIVERIES = Number(__ENV.LOAD_WEBHOOK_DELIVERIES || 24);
const COPIES = Number(__ENV.LOAD_WEBHOOK_COPIES || 20);

export const options = {
  batch: 100,
  batchPerHost: 100,
  scenarios: {
    webhooks: { executor: 'shared-iterations', vus: 5, iterations: DELIVERIES, maxDuration: '3m' },
  },
  thresholds: Object.assign({}, thresholds, { 'http_req_duration{kind:webhook}': ['p(95)<1000'] }),
};

function person(p) {
  return { id: p.id, login: p.login, type: 'User' };
}

function issuePayload(repositoryId, number, author) {
  const now = new Date().toISOString();
  return {
    action: 'closed',
    issue: {
      id: repositoryId * 1000 + number,
      number,
      title: `Load issue ${number}`,
      html_url: `https://github.com/load/repo/issues/${number}`,
      state: 'closed',
      state_reason: 'completed',
      user: person(author),
      assignees: [person(author)],
      assignee: person(author),
      labels: [],
      body: 'load test',
      created_at: now,
      updated_at: now,
      closed_at: now,
    },
    repository: {
      id: repositoryId,
      name: 'repo',
      full_name: 'load/repo',
      private: false,
      fork: false,
      archived: false,
      created_at: '2026-01-01T00:00:00Z',
      owner: { id: 1, login: 'load', type: 'User' },
      html_url: 'https://github.com/load/repo',
    },
    sender: person(author),
  };
}

export default function () {
  const n = exec.scenario.iterationInTest;
  const relevant = n % 2 === 0;
  const hook = fixture.webhook;
  const author = hook.people[0];
  const payload = issuePayload(
    relevant ? hook.repositoryId : hook.repositoryId + 100000,
    1000 + n,
    author,
  );
  payload.installation = { id: hook.installationId };
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'X-GitHub-Event': 'issues',
    'X-GitHub-Delivery': `load-${fixture.runId}-${n}`,
    'X-Hub-Signature-256': `sha256=${hmac('sha256', fixture.webhookSecret, body, 'hex')}`,
  };
  const requests = [];
  for (let i = 0; i < COPIES; i += 1) {
    requests.push({
      method: 'POST',
      url: `${BASE}/api/v1/webhooks/github`,
      body,
      params: { headers, tags: { name: 'receiveGithubWebhook', kind: 'webhook' } },
    });
  }
  const responses = http.batch(requests);
  const bad = responses.filter((r) => r.status !== 202);
  if (bad.length > 0) {
    violations.add(1);
    console.error(
      `CC-11 delivery ${n}: ${bad.length} of ${COPIES} copies were not 202 (first: ${bad[0].status})`,
    );
  }
  check(responses, { 'every copy accepted with 202': (rs) => rs.every((r) => r.status === 202) });
}
