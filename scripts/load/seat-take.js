// CC-1 under load (FR-TEAM-04, -30): N users with N different offers race for one seat.
// Invariant: exactly one 200, all others 409 SEAT_TAKEN; verify.mjs then checks one active assignment.
// One VU = one team (the rounds run in parallel with each other, which also exercises the lock order).
import http from 'k6/http';
import { check } from 'k6';
import { expectRace, fixture, thresholds, writeRequest } from './common.js';

export const options = {
  batch: 100,
  batchPerHost: 100,
  scenarios: {
    seat: {
      executor: 'per-vu-iterations',
      vus: fixture.seatRounds.length,
      iterations: 1,
      maxDuration: '2m',
    },
  },
  thresholds,
};

export default function () {
  const round = fixture.seatRounds[__VU - 1];
  const requests = round.candidates.map((c) =>
    writeRequest(
      'POST',
      `/v1/seat-offers/${c.offerId}/acceptance`,
      c.cookie,
      undefined,
      'acceptSeatOffer',
    ),
  );
  const responses = http.batch(requests);
  const won = expectRace(`CC-1 team ${round.teamId}`, responses, 200, 1, ['SEAT_TAKEN']);
  check(won, { 'exactly one candidate took the seat': (n) => n === 1 });
}
