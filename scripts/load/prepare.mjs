#!/usr/bin/env node
// Prepares the data of the load scenarios on the isolated stack (docs/release.md, section 5):
// signs people in through the real magic-link flow, builds teams through the public API and writes
// scripts/load/.data/fixture.json for k6. Direct SQL is used only where the real flow needs a third party
// (GitHub link of a person, a linked repository) or a day of waiting (stage age, required items).
// Usage: node scripts/load/prepare.mjs   (from the repository root, after `compose up`)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { call, createMember, expectStatus, resetRateLimits, sql } from './lib.mjs';

const int = (name, fallback) => Number(process.env[name] ?? fallback);
const SEAT_ROUNDS = int('LOAD_SEAT_ROUNDS', 1); // teams raced in parallel for CC-1
const SEAT_CANDIDATES = int('LOAD_SEAT_CANDIDATES', 20); // users that race for the one seat
const STAGE_TEAMS = int('LOAD_STAGE_TEAMS', 1); // teams whose lead fires parallel transitions (CC-5)
const STAGE_BURST = int('LOAD_STAGE_BURST', 20);
const CHECKLIST_MEMBERS = Math.min(int('LOAD_CHECKLIST_MEMBERS', 8), 8); // team size is 3..8
const CONCURRENCY = int('LOAD_PREPARE_CONCURRENCY', 4);

const runId = randomBytes(3).toString('hex');
const seat = (roleCode) => ({
  roleCode,
  desired: false,
  minLevel: 'junior',
  minHours: 6,
  stack: ['typescript'],
  count: 1,
});
const ROLES = ['backend', 'frontend', 'pm', 'designer', 'qa', 'devops', 'backend'];

/** Runs `tasks` (functions returning promises) with at most `limit` in flight, keeping the order of results. */
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    }),
  );
  return results;
}

const people = (label, count) =>
  pool(
    Array.from({ length: count }, (_, i) => () => createMember(`${label}${i}`, runId)),
    CONCURRENCY,
  );

async function createTeam(lead, name, roles) {
  return expectStatus(
    await call('POST', '/v1/teams', {
      cookie: lead.cookie,
      body: {
        name: `${name} ${runId}`,
        description: 'Load test team',
        timezone: 'Europe/Moscow',
        hoursPerWeek: 10,
        productTypeCode: 'web_service',
        seats: roles.map(seat),
      },
    }),
    201,
    'createTeam',
  );
}

async function offer(lead, team, seatId, user) {
  return expectStatus(
    await call('POST', `/v1/teams/${team.id}/seat-offers`, {
      cookie: lead.cookie,
      body: { seatId, userId: user.id },
    }),
    201,
    'createSeatOffer',
  );
}

/** A started team of `size` people: lead plus members who joined through offers (the production path). */
async function startedTeam(label, size) {
  const [lead, ...members] = await people(label, size);
  const team = await createTeam(lead, label, ROLES.slice(0, size - 1));
  for (const [i, member] of members.entries()) {
    const o = await offer(lead, team, team.seats[i].id, member);
    expectStatus(
      await call('POST', `/v1/seat-offers/${o.id}/acceptance`, { cookie: member.cookie }),
      200,
      'acceptSeatOffer',
    );
  }
  expectStatus(
    await call('POST', `/v1/teams/${team.id}/start`, { cookie: lead.cookie }),
    200,
    'startProject',
  );
  return { teamId: team.id, lead, members };
}

async function main() {
  const started = Date.now();
  const deadlocks = Number(
    sql(`SELECT deadlocks FROM pg_stat_database WHERE datname = 'teamforge'`)[0][0],
  );

  // CC-1: one forming team per round, one open seat, one pending offer per candidate.
  const seatRounds = [];
  for (let r = 0; r < SEAT_ROUNDS; r += 1) {
    const [lead, ...candidates] = await people(`seat${r}-`, SEAT_CANDIDATES + 1);
    const team = await createTeam(lead, `seat${r}`, ['backend']);
    const offers = [];
    for (const candidate of candidates) {
      offers.push((await offer(lead, team, team.seats[0].id, candidate)).id);
      if (offers.length % 25 === 0) resetRateLimits();
    }
    seatRounds.push({
      teamId: team.id,
      seatId: team.seats[0].id,
      candidates: candidates.map((c, i) => ({
        userId: c.id,
        cookie: c.cookie,
        offerId: offers[i],
      })),
    });
    resetRateLimits();
  }

  // CC-5: started teams; stage 1 is made closable the way a day of work would (see docs/release.md 5.4).
  const stageTeams = [];
  for (let t = 0; t < STAGE_TEAMS; t += 1) {
    const team = await startedTeam(`stage${t}-`, 3);
    sql(
      `UPDATE workspace.checklist_item SET required = false
         WHERE team_id = '${team.teamId}' AND project_stage_id IN
           (SELECT id FROM workspace.project_stage WHERE team_id = '${team.teamId}' AND ordinal = 1);
       UPDATE workspace.project_stage SET opened_at = opened_at - interval '2 days'
         WHERE team_id = '${team.teamId}' AND ordinal = 1`,
    );
    stageTeams.push({ teamId: team.teamId, leadCookie: team.lead.cookie, burst: STAGE_BURST });
    resetRateLimits();
  }

  // CC-7 and CC-11: one started team of up to 8 people, a ritual item with a version, a linked repository.
  const work = await startedTeam('work', CHECKLIST_MEMBERS);
  const items = expectStatus(
    await call('GET', `/v1/teams/${work.teamId}/stages/1/checklist`, { cookie: work.lead.cookie }),
    200,
    'checklist',
  ).items;
  const item = items.find((i) => i.kind === 'ritual' && i.ownerRole === 'any');
  if (!item) throw new Error('no ritual item with owner role "any" on stage 1');
  const installationId = Number(`${Date.now()}`.slice(-9)) + 1_000_000_000;
  const repositoryId = installationId + 1;
  sql(
    `INSERT INTO github.gh_installation (installation_id, account_id, account_login, account_type, status, updated_at)
       VALUES (${installationId}, ${installationId}, 'load-${runId}', 'User', 'active', now());
     INSERT INTO github.repo_link (id, team_id, repository_id, installation_id, full_name, is_private, is_fork, repo_created_at, status, linked_by, linked_at)
       VALUES (gen_random_uuid(), '${work.teamId}', ${repositoryId}, ${installationId}, 'load-${runId}/repo', false, false, now() - interval '30 days', 'active', '${work.lead.id}', now())`,
  );

  const env = readFileSync('.env', 'utf8');
  const secret = /^GITHUB_WEBHOOK_SECRET=(.*)$/m.exec(env)?.[1]?.trim();
  if (!secret)
    throw new Error('GITHUB_WEBHOOK_SECRET is not set in .env (run `node scripts/env-init.mjs`)');

  const assignees = work.members.slice(0, 2);
  const fixture = {
    runId,
    createdAt: new Date().toISOString(),
    deadlocksBefore: deadlocks,
    webhookSecret: secret,
    seatRounds,
    stageTeams,
    checklist: {
      teamId: work.teamId,
      itemId: item.id,
      leadCookie: work.lead.cookie,
      members: [work.lead, ...work.members].map((m) => ({ userId: m.id, cookie: m.cookie })),
    },
    webhook: {
      installationId,
      repositoryId,
      teamId: work.teamId,
      // GitHub identities of two members: the payloads name them as author and assignee (attribution).
      people: sql(
        `SELECT github_user_id, github_login FROM auth."user" WHERE id IN (${assignees.map((m) => `'${m.id}'`).join(',')})`,
      ).map(([id, login]) => ({ id: Number(id), login })),
    },
  };
  mkdirSync(new URL('.data/', import.meta.url), { recursive: true });
  writeFileSync(new URL('.data/fixture.json', import.meta.url), JSON.stringify(fixture, null, 2));
  console.log(
    `fixture ready in ${Math.round((Date.now() - started) / 1000)} s: ${SEAT_ROUNDS}x${SEAT_CANDIDATES} seat candidates, ` +
      `${STAGE_TEAMS} stage teams, checklist team of ${CHECKLIST_MEMBERS}, run ${runId}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
