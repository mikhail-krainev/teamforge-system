// What finished projects leave behind: completion, credits, badges, peer reviews and anti-fraud cases.
import { DECISION_COMMENT, DISPUTE_TEXT, REVIEW_TEXTS, VIOLATION_COMMENT } from './content.mjs';
import { DAY_MS, HOUR_MS, dateOnly } from './world.mjs';

const COOLING_MS = 7 * DAY_MS;
const REVIEW_WINDOW_MS = 14 * DAY_MS;

export function buildResults(world, team, admin) {
  if (team.storage) {
    world.add('workspace.project_storage_usage', {
      team_id: team.id,
      files_count: Math.min(team.storage.files, 30),
      bytes_total: Math.min(team.storage.bytes, 52_428_800),
    });
  }
  if (!team.completedAt) return;
  const overdueDays = Math.max(0, Math.ceil((team.completedAt - team.plannedEndAt) / DAY_MS));
  team.overdueDays = overdueDays;
  addCompletion(world, team, overdueDays);
  addCreditRun(world, team);
  if (team.bp.fraud) addFraudCase(world, team, admin);
  if (team.bp.reviews === 'published') addPublishedReviews(world, team);
  if (team.bp.reviews === 'window') addReviewWindow(world, team);
}

function addCompletion(world, team, overdueDays) {
  const lead = team.members.find((m) => m.isLead);
  world.add('workspace.completion_check', {
    id: world.id(),
    team_id: team.id,
    status: 'done',
    results: [],
    requested_by: lead.person.userId,
    requested_at: new Date(team.completedAt.getTime() - HOUR_MS),
    finished_at: new Date(team.completedAt.getTime() - 0.9 * HOUR_MS),
    valid_until: new Date(team.completedAt.getTime() + 23 * HOUR_MS),
  });
  world.add('workspace.project_completion', {
    team_id: team.id,
    completed_at: team.completedAt,
    planned_end_at: team.plannedEndAt,
    overdue_days: overdueDays,
    completed_by: lead.person.userId,
    snapshot: snapshotOf(team, overdueDays),
  });
}

/** The frozen picture of the project the credit is computed from (workspace completion-snapshot.ts). */
function snapshotOf(team, overdueDays) {
  return {
    teamId: team.id,
    completedAt: team.completedAt.toISOString(),
    startedAt: team.startedAt.toISOString(),
    plannedEndAt: team.plannedEndAt.toISOString(),
    overdueDays,
    productType: team.bp.type,
    releaseUrl: `https://${team.bp.slug}-demo.vercel.app`,
    repositoryId: team.repo?.id ?? null,
    roster: {
      members: team.members.map((m) => ({
        userId: m.person.userId,
        isLead: m.isLead,
        joinedAt: m.joinedAt.toISOString(),
        joinedVia: m.seat.via,
        roles: [{ roleCode: m.seat.role, deficitAtJoin: m.deficitAtJoin }],
      })),
      seats: team.seats.map((s) => ({
        seatId: s.id,
        roleCode: s.role,
        desired: s.desired,
        holderUserId: s.holder?.userId ?? null,
      })),
      departedUserIds: [],
    },
    stages: team.playbook.stages.map((s, i) => ({
      ordinal: s.ordinal,
      stageKey: s.key,
      openedAt: team.timeline[i].openedAt.toISOString(),
      closedAt: team.timeline[i].closedAt.toISOString(),
    })),
    contributions: team.contributions.map((c) => ({
      id: c.id,
      userId: c.user_id,
      roleCode: c.role_code,
      stageOrdinal: c.stage_ordinal,
      source: c.source,
      ref: c.ref,
      receivedAt: c.received_at.toISOString(),
    })),
    participationConfirms: [],
  };
}

/** C-17b: 7 days of cooling, then the credit (or a frozen run waiting for the administrator). */
function addCreditRun(world, team) {
  const status = team.bp.credit;
  const coolingUntil = new Date(team.completedAt.getTime() + COOLING_MS);
  const creditedAt = status === 'credited' ? coolingUntil : null;
  world.add('rewards.credit_run', {
    team_id: team.id,
    completed_at: team.completedAt,
    cooling_until: coolingUntil,
    status,
    roster_hash: world.bytes(`roster:${team.id}`),
    fraud_score: team.bp.fraud ? 4 : world.int(0, 1),
    credited_at: creditedAt,
    version: status === 'cooling' ? 1 : 2,
  });
  if (status !== 'credited') return;
  team.members.forEach((m, i) => {
    const denied = team.bp.deniedOne && i === team.members.length - 1;
    world.add('rewards.project_credit', {
      team_id: team.id,
      user_id: m.person.userId,
      status: denied ? 'denied' : 'credited',
      reason: denied ? 'NO_CONTRIBUTION' : null,
      product_type_code: team.bp.type,
      overdue_days: team.overdueDays,
      completed_at: team.completedAt,
      roster_hash: world.bytes(`roster:${team.id}`),
      decided_at: creditedAt,
    });
    world.add('rewards.credit', {
      team_id: team.id,
      user_id: m.person.userId,
      role_code: m.seat.role,
      status: denied ? 'denied' : 'credited',
      deficit_at_join: m.deficitAtJoin,
      credited_at: denied ? null : creditedAt,
    });
    if (!denied) recordCredit(world, m, team, creditedAt);
  });
}

function recordCredit(world, member, team, creditedAt) {
  const p = member.person;
  p.credits ??= [];
  p.credits.push({
    role: member.seat.role,
    type: team.bp.type,
    at: creditedAt,
    onTime: team.overdueDays === 0,
    deficit: member.deficitAtJoin,
    team,
    desired: member.seat.desired,
  });
}

/** Counters and badges (FR-REW-05) from the credits gathered over all projects. */
export function buildRewards(world) {
  for (const p of world.people.values()) {
    const credits = (p.credits ?? []).sort((a, b) => a.at - b.at);
    if (credits.length === 0) continue;
    world.add('rewards.counter', { user_id: p.userId, role_code: null, value: credits.length });
    const byRole = Map.groupBy(credits, (c) => c.role);
    for (const [role, list] of byRole)
      world.add('rewards.counter', { user_id: p.userId, role_code: role, value: list.length });
    const award = (code, at, extra = {}) =>
      world.add('rewards.award', {
        id: world.id(),
        user_id: p.userId,
        badge_code: code,
        scope: 'individual',
        team_id: null,
        awarded_at: at,
        revoked_at: null,
        revoke_reason: null,
        ...extra,
      });
    award('projects_1', credits[0].at);
    if (credits.length >= 3) award('projects_2', credits[2].at);
    if (byRole.size >= 2) award('roles_1', credits.find((c) => c.role !== credits[0].role).at);
    if (new Set(credits.map((c) => c.type)).size >= 2) award('product_types_1', credits.at(-1).at);
    const onTime = credits.find((c) => c.onTime);
    if (onTime) award('on_time', onTime.at);
    const deficit = credits.find((c) => c.deficit);
    if (deficit) award('closed_deficit', deficit.at);
    for (const c of credits.filter((x) => x.desired)) {
      world.add('rewards.award', {
        id: world.id(),
        user_id: p.userId,
        badge_code: 'closed_vacancy',
        scope: 'team',
        team_id: c.team.id,
        awarded_at: c.at,
        revoked_at: null,
        revoke_reason: null,
      });
    }
  }
}

const SIGNALS = {
  'open-dispute': [
    [
      'completion',
      'AF-05',
      'flag',
      0,
      { changedLines: 31, maxShare: 0.94, tooFewLines: true, oneBigPr: true },
    ],
    ['completion', 'AF-12', 'signal', 2, { stages: 8 }],
    ['completion', 'AF-20', 'signal', 2, { events: 9 }],
  ],
  open: [
    ['completion', 'AF-03', 'flag', 0, { ageDays: 412 }],
    ['completion', 'AF-14', 'signal', 1, { roleCodes: ['qa'] }],
    ['cooling_end', 'AF-22', 'flag', 0, { score: 4 }],
  ],
  'open-fresh': [
    [
      'completion',
      'AF-05',
      'flag',
      0,
      { changedLines: 148, maxShare: 0.81, tooFewLines: false, oneBigPr: true },
    ],
    ['completion', 'AF-20', 'signal', 2, { events: 17 }],
  ],
  'decided-ok': [
    ['completion', 'AF-12', 'signal', 2, { stages: 8 }],
    ['completion', 'AF-19', 'signal', 1, {}],
  ],
  'decided-violation': [
    [
      'completion',
      'AF-05',
      'flag',
      0,
      { changedLines: 12, maxShare: 1, tooFewLines: true, oneBigPr: true },
    ],
    ['completion', 'AF-12', 'signal', 2, { stages: 8 }],
    ['completion', 'AF-20', 'signal', 2, { events: 6 }],
  ],
};

/** The administrator's decision of a case that is already closed. */
const DECISIONS = {
  'decided-ok': { status: 'ok', comment: DECISION_COMMENT },
  'decided-violation': { status: 'violation', comment: VIOLATION_COMMENT },
};

function addFraudCase(world, team, admin) {
  const kind = team.bp.fraud;
  const coolingEnd = kind === 'open';
  const openedAt = new Date(team.completedAt.getTime() + (coolingEnd ? COOLING_MS : 10 * 60_000));
  addSignals(world, team, SIGNALS[kind]);
  const decided = DECISIONS[kind];
  addCase(world, team, admin, { kind, decided, openedAt });
}

function addSignals(world, team, signals) {
  for (const [phase, rule, action, score, data] of signals) {
    const at =
      phase === 'cooling_end'
        ? new Date(team.completedAt.getTime() + COOLING_MS)
        : new Date(team.completedAt.getTime() + 5 * 60_000);
    world.add('rewards.fraud_signal', {
      id: world.id(),
      team_id: team.id,
      phase,
      rule_code: rule,
      action,
      score,
      data,
      created_at: at,
    });
  }
}

function addCase(world, team, admin, { kind, decided, openedAt }) {
  const caseId = world.id();
  world.add('rewards.fraud_case', {
    id: caseId,
    team_id: team.id,
    status: decided?.status ?? 'open',
    opened_at: openedAt,
    decided_by: decided ? admin.userId : null,
    decided_at: decided ? new Date(openedAt.getTime() + 2 * DAY_MS) : null,
    comment: decided?.comment ?? null,
  });
  if (decided) {
    world.add('rewards.admin_audit', {
      id: world.id(),
      actor_user_id: admin.userId,
      action: `fraud_case_${decided.status}`,
      target_type: 'fraud_case',
      target_id: caseId,
      reason: decided.comment,
      data: { teamId: team.id },
      at: new Date(openedAt.getTime() + 2 * DAY_MS),
    });
  }
  if (kind === 'open-dispute') {
    const author = team.members.find((m) => m.isLead).person;
    world.add('rewards.dispute', {
      id: world.id(),
      team_id: team.id,
      user_id: author.userId,
      text: DISPUTE_TEXT,
      created_at: new Date(team.completedAt.getTime() + 20 * HOUR_MS),
    });
  }
}

/** Two or three reviews per member, published after the 14-day window (SEC-04: authors stay hidden). */
function addPublishedReviews(world, team) {
  const windowUntil = new Date(team.completedAt.getTime() + REVIEW_WINDOW_MS);
  const publishedOn = dateOnly(windowUntil);
  for (const m of team.members) {
    world.add('profiles.review_eligibility', {
      team_id: team.id,
      user_id: m.person.userId,
      team_name: team.bp.name,
      window_until: windowUntil,
    });
  }
  for (const subject of team.members) {
    const authors = team.members.filter((m) => m !== subject).slice(0, world.int(2, 3));
    for (const author of authors) addReview(world, team, author, subject, 'published', publishedOn);
  }
}

/** The project finished days ago: members may still write reviews; a few are already written. */
function addReviewWindow(world, team) {
  const until = new Date(team.completedAt.getTime() + REVIEW_WINDOW_MS);
  for (const m of team.members) {
    world.add('profiles.review_eligibility', {
      team_id: team.id,
      user_id: m.person.userId,
      team_name: team.bp.name,
      window_until: until,
    });
  }
  const others = team.members.filter((m) => !m.person.isDemo);
  for (const author of others.slice(0, 2)) {
    for (const subject of team.members.filter((m) => m !== author))
      addReview(world, team, author, subject, 'pending', null);
  }
}

function addReview(world, team, author, subject, status, publishedOn) {
  const reviewId = world.id();
  world.add('profiles.peer_review', {
    id: reviewId,
    team_id: team.id,
    subject_user_id: subject.person.userId,
    text: world.pick(REVIEW_TEXTS),
    status,
    published_on: publishedOn,
    sort_key: world.int(1, 1_000_000),
    purge_after: null,
  });
  world.add('profiles.peer_review_authorship', {
    review_id: reviewId,
    team_id: team.id,
    author_user_id: author.person.userId,
    subject_user_id: subject.person.userId,
  });
}
