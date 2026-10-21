#!/usr/bin/env node
// Checks the database invariants after the k6 scenarios (docs/release.md, section 5): the responses say who won,
// the database says whether the state is consistent. Exit code 1 when any invariant is broken.
// Usage: node scripts/load/verify.mjs   (from the repository root; same env names as run.sh)
import { readFileSync } from 'node:fs';
import { sql } from './lib.mjs';

const fixture = JSON.parse(readFileSync(new URL('.data/fixture.json', import.meta.url), 'utf8'));
const ROUNDS = Number(process.env.LOAD_CHECKLIST_ROUNDS ?? 20);
const DELIVERIES = Number(process.env.LOAD_WEBHOOK_DELIVERIES ?? 24);
const num = (statement) => Number(sql(statement)[0][0]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`,
  );
}

// CC-1: one active holder per seat, the seat is filled, lead plus one winner are active members, one accepted offer.
for (const round of fixture.seatRounds) {
  const t = `'${round.teamId}'`;
  check(
    `CC-1 ${round.teamId.slice(-6)}: active assignments of the seat`,
    num(
      `SELECT count(*) FROM teams.seat_assignment WHERE seat_id = '${round.seatId}' AND ended_at IS NULL`,
    ),
    1,
  );
  check(
    `CC-1 ${round.teamId.slice(-6)}: seat status`,
    sql(`SELECT status FROM teams.seat WHERE id = '${round.seatId}'`)[0][0],
    'filled',
  );
  check(
    `CC-1 ${round.teamId.slice(-6)}: active members`,
    num(`SELECT count(*) FROM teams.membership WHERE team_id = ${t} AND status = 'active'`),
    2,
  );
  check(
    `CC-1 ${round.teamId.slice(-6)}: accepted offers`,
    num(`SELECT count(*) FROM teams.seat_offer WHERE team_id = ${t} AND status = 'accepted'`),
    1,
  );
}

// CC-5: stage 1 closed, stage 2 open and the only open one, the items of stage 2 exist once per step.
for (const team of fixture.stageTeams) {
  const t = `'${team.teamId}'`;
  const label = `CC-5 ${team.teamId.slice(-6)}`;
  check(
    `${label}: stage statuses 1,2`,
    sql(
      `SELECT status FROM workspace.project_stage WHERE team_id = ${t} AND ordinal <= 2 ORDER BY ordinal`,
    ).map((r) => r[0]),
    ['closed', 'open'],
  );
  check(
    `${label}: open stages`,
    num(`SELECT count(*) FROM workspace.project_stage WHERE team_id = ${t} AND status = 'open'`),
    1,
  );
  const items = sql(
    `SELECT count(*), count(DISTINCT step_key) FROM workspace.checklist_item i JOIN workspace.project_stage s ON s.id = i.project_stage_id WHERE i.team_id = ${t} AND s.ordinal = 2`,
  )[0].map(Number);
  check(
    `${label}: items of stage 2 are unique and present`,
    items[0] > 0 && items[0] === items[1],
    true,
  );
}

// CC-7: every round bumped the version exactly once.
check(
  'CC-7: item version after the rounds',
  num(`SELECT version FROM workspace.checklist_item WHERE id = '${fixture.checklist.itemId}'`),
  1 + ROUNDS,
);

// CC-11: one row per delivery id; wait until the worker has processed what it queued.
const prefix = `load-${fixture.runId}-`;
for (let i = 0; i < 60; i += 1) {
  if (
    num(
      `SELECT count(*) FROM github.webhook_delivery WHERE delivery_id LIKE '${prefix}%' AND status = 'received'`,
    ) === 0
  )
    break;
  await sleep(1000);
}
check(
  'CC-11: rows of webhook_delivery (one per delivery id)',
  num(`SELECT count(*) FROM github.webhook_delivery WHERE delivery_id LIKE '${prefix}%'`),
  DELIVERIES,
);
check(
  'CC-11: no delivery failed or is still received',
  num(
    `SELECT count(*) FROM github.webhook_delivery WHERE delivery_id LIKE '${prefix}%' AND status IN ('received','failed')`,
  ),
  0,
);
check(
  'CC-11: ignored deliveries (unknown repository)',
  num(
    `SELECT count(*) FROM github.webhook_delivery WHERE delivery_id LIKE '${prefix}%' AND status = 'ignored'`,
  ),
  Math.floor(DELIVERIES / 2),
);
check(
  'CC-11: contributions of the team (one per relevant delivery)',
  num(`SELECT count(*) FROM workspace.contribution WHERE team_id = '${fixture.webhook.teamId}'`),
  Math.ceil(DELIVERIES / 2),
);

// All scenarios: PostgreSQL resolved no deadlock.
const deadlocks = num(`SELECT deadlocks FROM pg_stat_database WHERE datname = 'teamforge'`);
check('PostgreSQL deadlocks since prepare', deadlocks - fixture.deadlocksBefore, 0);

console.log(failed === 0 ? '\nAll invariants hold.' : `\n${failed} invariant(s) broken.`);
process.exit(failed === 0 ? 0 : 1);
