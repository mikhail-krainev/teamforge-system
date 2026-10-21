// CC-7 under load (FR-WORK-04): every team member writes the same checklist item with the same version.
// Per round: read the version, then all members PATCH with that version at once. Invariant: exactly one 200
// whose body carries version+1, all others 409 VERSION_CONFLICT. After R rounds the item has version 1+R
// (verify.mjs checks it). Each member sends one write per round, well under the 60/min write limit.
import http from 'k6/http';
import { check } from 'k6';
import {
  expectRace,
  fixture,
  readRequest,
  thresholds,
  violations,
  writeRequest,
} from './common.js';

const ROUNDS = Number(__ENV.LOAD_CHECKLIST_ROUNDS || 20);

export const options = {
  batch: 100,
  batchPerHost: 100,
  scenarios: {
    checklist: { executor: 'per-vu-iterations', vus: 1, iterations: 1, maxDuration: '2m' },
  },
  thresholds,
};

function currentVersion() {
  const path = `/v1/teams/${fixture.checklist.teamId}/stages/1/checklist`;
  const req = readRequest(path, fixture.checklist.leadCookie, 'getStageChecklist');
  const res = http.get(req.url, req.params);
  const item = (res.json('items') || []).filter((i) => i.id === fixture.checklist.itemId)[0];
  return item ? item.version : -1;
}

export default function () {
  const { teamId, itemId, members } = fixture.checklist;
  for (let round = 0; round < ROUNDS; round += 1) {
    const version = currentVersion();
    if (version < 1) {
      violations.add(1);
      console.error('CC-7: the item is not readable');
      return;
    }
    const requests = members.map((m, j) =>
      writeRequest(
        'PATCH',
        `/v1/teams/${teamId}/checklist-items/${itemId}`,
        m.cookie,
        { version, outcome: `Load round ${round}, writer ${j}, based on version ${version}` },
        'updateChecklistItem',
      ),
    );
    const responses = http.batch(requests);
    expectRace(`CC-7 round ${round} (version ${version})`, responses, 200, 1, ['VERSION_CONFLICT']);
    const winner = responses.filter((r) => r.status === 200)[0];
    check(winner, {
      'the winner got version+1': (r) => r !== undefined && r.json('version') === version + 1,
    });
  }
}
