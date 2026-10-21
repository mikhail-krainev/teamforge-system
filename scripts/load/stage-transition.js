// CC-5 under load (FR-WORK-10): the lead of each team fires N parallel "go to the next stage" requests.
// Invariant: exactly one 201 per team, all others 409 STAGE_NOT_OPEN; verify.mjs then checks one open stage
// and the items of stage 2 created once. One VU = one team.
import http from 'k6/http';
import { check } from 'k6';
import { expectRace, fixture, thresholds, writeRequest } from './common.js';

export const options = {
  batch: 100,
  batchPerHost: 100,
  scenarios: {
    stage: {
      executor: 'per-vu-iterations',
      vus: fixture.stageTeams.length,
      iterations: 1,
      maxDuration: '2m',
    },
  },
  thresholds,
};

export default function () {
  const team = fixture.stageTeams[__VU - 1];
  const requests = [];
  for (let i = 0; i < team.burst; i += 1) {
    requests.push(
      writeRequest(
        'POST',
        `/v1/teams/${team.teamId}/stage-transitions`,
        team.leadCookie,
        { fromOrdinal: 1 },
        'transitionStage',
      ),
    );
  }
  const responses = http.batch(requests);
  const won = expectRace(`CC-5 team ${team.teamId}`, responses, 201, 1, ['STAGE_NOT_OPEN']);
  check(won, { 'exactly one transition': (n) => n === 1 });
}
