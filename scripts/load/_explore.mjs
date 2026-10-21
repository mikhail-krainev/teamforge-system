import { createMember, call, expectStatus, sql, resetRateLimits } from './lib.mjs';
const run = Date.now().toString(36);
const t0 = Date.now();
const lead = await createMember('lead', run);
console.log('signin ms', Date.now() - t0);
const seat = (roleCode) => ({
  roleCode,
  desired: false,
  minLevel: 'junior',
  minHours: 6,
  stack: ['typescript'],
  count: 1,
});
const team = expectStatus(
  await call('POST', '/v1/teams', {
    cookie: lead.cookie,
    body: {
      name: 'Load team ' + run,
      description: 'x',
      timezone: 'Europe/Moscow',
      hoursPerWeek: 10,
      productTypeCode: 'web_service',
      seats: [seat('backend'), seat('frontend')],
    },
  }),
  201,
  'createTeam',
);
const members = [];
for (const [i, s] of team.seats.entries()) {
  const m = await createMember('m' + i, run);
  const offer = expectStatus(
    await call('POST', `/v1/teams/${team.id}/seat-offers`, {
      cookie: lead.cookie,
      body: { seatId: s.id, userId: m.id },
    }),
    201,
    'offer',
  );
  expectStatus(
    await call('POST', `/v1/seat-offers/${offer.id}/acceptance`, { cookie: m.cookie }),
    200,
    'accept',
  );
  members.push(m);
}
const start = await call('POST', `/v1/teams/${team.id}/start`, { cookie: lead.cookie });
console.log('start', start.status, start.text.slice(0, 300));
const stages = await call('GET', `/v1/teams/${team.id}/stages`, { cookie: lead.cookie });
console.log(stages.status, stages.text.slice(0, 500));
const cl = await call('GET', `/v1/teams/${team.id}/stages/1/checklist`, { cookie: lead.cookie });
console.log(
  cl.status,
  JSON.stringify(
    cl.json?.items?.map((i) => [
      i.id,
      i.stepKey,
      i.kind,
      i.status,
      i.version,
      i.required,
      i.ownerRole,
    ]),
  ),
);
console.log(
  sql(
    `select status, opened_at from workspace.project_stage where team_id='${team.id}' order by ordinal`,
  ),
);
console.log(JSON.stringify({ team: team.id, lead: lead.cookie.slice(0, 30) }));
sql(
  `UPDATE workspace.checklist_item SET required=false WHERE team_id='${team.id}' AND project_stage_id IN (SELECT id FROM workspace.project_stage WHERE team_id='${team.id}' AND ordinal=1)`,
);
sql(
  `UPDATE workspace.project_stage SET opened_at = opened_at - interval '2 days' WHERE team_id='${team.id}' AND ordinal=1`,
);
const tr = await call('POST', `/v1/teams/${team.id}/stage-transitions`, {
  cookie: lead.cookie,
  body: { fromOrdinal: 1 },
});
console.log('transition', tr.status, tr.text.slice(0, 300));
const tr2 = await call('POST', `/v1/teams/${team.id}/stage-transitions`, {
  cookie: lead.cookie,
  body: { fromOrdinal: 1 },
});
console.log('transition2', tr2.status, tr2.text.slice(0, 300));
const item = cl.json.items[0];
const p = await call('PATCH', `/v1/teams/${team.id}/checklist-items/${item.id}`, {
  cookie: members[0].cookie,
  body: { version: item.version, outcome: 'x'.repeat(25) },
});
console.log('patch', p.status, p.text.slice(0, 300));
const p2 = await call('PATCH', `/v1/teams/${team.id}/checklist-items/${item.id}`, {
  cookie: members[1].cookie,
  body: { version: item.version, outcome: 'y'.repeat(25) },
});
console.log('patch2', p2.status, p2.text.slice(0, 300));
console.log(sql(`select table_name from information_schema.tables where table_schema='github'`));
