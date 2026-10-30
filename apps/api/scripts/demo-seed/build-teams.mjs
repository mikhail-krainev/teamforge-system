// Teams, seats, memberships and how people got there (offers, requests, invitations, the queue).
import { JOIN_REQUEST_MESSAGE, OFFER_MESSAGE } from './content.mjs';
import { DAY_MS, HOUR_MS } from './world.mjs';

const TRIAL_MS = 7 * DAY_MS;
const OFFER_TTL_MS = 7 * DAY_MS;
const MAX_PROJECT_DAYS = 120;

const at = (date, hours) => new Date(date.getTime() + hours * HOUR_MS);

/** Opening and closing moments of the stages, counted back from the open stage or the completion. */
export function stageTimeline(world, bp, playbook) {
  const stages = playbook.stages;
  const pace = bp.pace ?? 1;
  const times = stages.map(() => ({ openedAt: null, closedAt: null }));
  const last = bp.status === 'completed' ? stages.length : bp.stage;
  let cursor =
    bp.status === 'completed' ? world.ago(bp.completedDaysAgo + 0.2) : world.ago(bp.openDaysAgo);
  if (bp.status !== 'completed') times[last - 1].openedAt = cursor;
  for (let i = bp.status === 'completed' ? last - 1 : last - 2; i >= 0; i -= 1) {
    times[i].closedAt = cursor;
    cursor = new Date(
      cursor.getTime() - stages[i].durationDays * pace * world.between(0.85, 1.05) * DAY_MS,
    );
    times[i].openedAt = cursor;
    if (i + 1 < stages.length && times[i + 1].openedAt === null)
      times[i + 1].openedAt = times[i].closedAt;
  }
  return times;
}

/** Creates the team and its people. Returns what the work and results builders need. */
export function buildTeam(world, bp, playbook) {
  const teamId = world.id();
  const started = bp.status !== 'forming';
  const timeline = started ? stageTimeline(world, bp, playbook) : [];
  const startedAt = started ? timeline[0].openedAt : null;
  const createdAt = started
    ? new Date(startedAt.getTime() - world.between(3, 8) * DAY_MS)
    : world.ago(bp.createdDaysAgo);
  const totalDays = playbook.stages.reduce((sum, s) => sum + s.durationDays, 0);
  const plannedEndAt = started
    ? new Date(startedAt.getTime() + Math.min(totalDays, MAX_PROJECT_DAYS) * DAY_MS)
    : null;
  const completedAt = bp.status === 'completed' ? world.ago(bp.completedDaysAgo) : null;
  const team = {
    id: teamId,
    bp,
    playbook,
    createdAt,
    startedAt,
    plannedEndAt,
    completedAt,
    timeline,
    seats: [],
    members: [],
  };

  team.seats = placeSeats(world, bp);
  addFormerLead(world, team);
  const leadSeat = team.seats.find((s) => s.via === 'creator');
  team.lead = leadSeat?.holder ?? null;
  team.creator = team.lead ?? team.formerLead;

  for (const s of team.seats) if (s.holder) addMember(world, team, s);
  addTeamRow(world, team);
  addSeats(world, team);
  addJournal(world, team);
  addOpenOffers(world, team);
  return team;
}

/** The seats of the blueprint with their holders, counted against everybody's project limit. */
function placeSeats(world, bp) {
  const seats = [];
  const taken = new Set();
  const ordinals = {};
  for (const s of bp.seats) {
    const seatId = world.id();
    ordinals[s.role] = (ordinals[s.role] ?? 0) + 1;
    const holder =
      s.holder === null
        ? null
        : s.holder === 'auto'
          ? world.pickHolder(s.role, bp.status, taken)
          : world.person(s.holder);
    if (holder) {
      taken.add(holder.key);
      world.join(holder, bp.status);
    }
    seats.push({
      id: seatId,
      role: s.role,
      ordinal: ordinals[s.role],
      desired: s.desired === true,
      holder,
      via: s.via,
      trial: s.trial === true,
      level: s.level,
    });
  }
  return seats;
}

/** The voting team lost its lead: he left, his seat is open again, and the vote runs (build-results). */
function addFormerLead(world, team) {
  if (!team.bp.formerLead) return;
  const person = world.pickHolder(
    team.bp.formerLead,
    'completed',
    new Set(team.seats.flatMap((s) => (s.holder ? [s.holder.key] : []))),
  );
  team.formerLead = person;
  world.join(person, 'completed');
}

function joinMoment(world, team, seat) {
  if (seat.via === 'creator') return team.createdAt;
  if (seat.trial) return world.ago(world.between(1, 5));
  const until = team.startedAt ?? world.now;
  return world.during(at(team.createdAt, 2), at(until, -2));
}

function addMember(world, team, seat) {
  const joinedAt = joinMoment(world, team, seat);
  const membershipId = world.id();
  const viaAuto = seat.via === 'auto';
  const trialUntil = viaAuto ? new Date(joinedAt.getTime() + TRIAL_MS) : null;
  const trialOver = trialUntil !== null && trialUntil.getTime() <= world.now.getTime();
  const applicationId = viaAuto ? addFulfilledApplication(world, team, seat, joinedAt) : null;
  const member = {
    person: seat.holder,
    membershipId,
    joinedAt,
    seat,
    roles: [seat.role],
    isLead: seat.via === 'creator',
  };
  team.members.push(member);
  world.add('teams.membership', {
    id: membershipId,
    team_id: team.id,
    user_id: seat.holder.userId,
    status: 'active',
    joined_via: seat.via,
    joined_at: joinedAt,
    trial_until: trialUntil,
    trial_confirmed_at: trialOver ? at(joinedAt, world.between(20, 100)) : null,
    application_id: applicationId,
    left_at: null,
    left_reason: null,
  });
  const deficit = viaAuto || world.chance(0.2);
  world.add('teams.seat_assignment', {
    id: world.id(),
    seat_id: seat.id,
    team_id: team.id,
    membership_id: membershipId,
    user_id: seat.holder.userId,
    role_code: seat.role,
    joined_via: seat.via,
    started_at: joinedAt,
    ended_at: null,
    deficit_at_join: deficit,
    deficit_open_seats: deficit ? world.int(4, 12) : world.int(0, 2),
    deficit_queued: deficit ? world.int(0, 1) : world.int(2, 9),
  });
  member.deficitAtJoin = deficit;
  addHowJoined(world, team, member);
}

/** The offer, request or invitation that brought the member in. */
function addHowJoined(world, team, member) {
  const { seat, joinedAt, person } = member;
  if (seat.via === 'offer' || seat.via === 'request') {
    const createdAt = new Date(joinedAt.getTime() - world.between(4, 40) * HOUR_MS);
    world.add('teams.seat_offer', {
      id: world.id(),
      team_id: team.id,
      seat_id: seat.id,
      user_id: person.userId,
      direction: seat.via === 'offer' ? 'lead_to_user' : 'user_to_lead',
      status: 'accepted',
      message: seat.via === 'request' ? 'Хочу в команду, есть свободные вечера.' : null,
      expires_at: new Date(createdAt.getTime() + OFFER_TTL_MS),
      created_at: createdAt,
      decided_at: joinedAt,
    });
  }
  if (seat.via === 'invite') {
    world.add('teams.invitation', {
      id: world.id(),
      team_id: team.id,
      seat_id: seat.id,
      token_hash: world.bytes(`invite:${seat.id}`),
      invitee_github_user_id: person.githubUserId,
      invitee_github_login: person.githubLogin,
      invitee_email_hmac: null,
      status: 'used',
      expires_at: new Date(joinedAt.getTime() + 5 * DAY_MS),
      used_by: person.userId,
      used_at: joinedAt,
      created_by: team.creator.userId,
      created_at: new Date(joinedAt.getTime() - 2 * DAY_MS),
    });
  }
}

/** The queue application the auto-add fulfilled, its log line and the waiting time sample. */
function addFulfilledApplication(world, team, seat, joinedAt) {
  const id = world.id();
  const enqueuedAt = new Date(joinedAt.getTime() - world.between(2, 12) * DAY_MS);
  world.add('matching.search_application', {
    id,
    user_id: seat.holder.userId,
    status: 'fulfilled',
    enqueued_at: enqueuedAt,
    paused_seconds: 0,
    fulfilled_at: joinedAt,
    fulfilled_seat_id: seat.id,
    fulfilled_role_code: seat.role,
    fulfilled_team_id: team.id,
    cancelled_at: null,
    restored_at: null,
    version: 2,
  });
  world.add('matching.application_role', {
    application_id: id,
    role_code: seat.role,
    priority: 1,
    added_at: enqueuedAt,
    is_active: false,
  });
  world.add('matching.auto_add_log', {
    id: world.id(),
    run_id: world.id(),
    application_id: id,
    seat_id: seat.id,
    outcome: 'added',
    reason: null,
    at: joinedAt,
  });
  world.add('matching.wait_sample', {
    id: world.id(),
    application_id: id,
    role_code: seat.role,
    waited_seconds: Math.round((joinedAt - enqueuedAt) / 1000),
    matched_at: joinedAt,
  });
  return id;
}

function addTeamRow(world, team) {
  const { bp } = team;
  const voting = bp.status === 'voting';
  world.add('teams.team', {
    id: team.id,
    name: bp.name,
    description: bp.description,
    product_type_code: bp.type,
    playbook_id: team.playbook.id,
    lead_user_id: voting ? null : team.lead.userId,
    status: bp.status,
    status_reason: null,
    status_before_vote: voting ? 'active' : null,
    timezone: bp.timezone,
    hours_per_week: bp.hours,
    member_count: team.members.length,
    seat_count: team.seats.length,
    started_at: team.startedAt,
    planned_end_at: team.plannedEndAt,
    completed_at: team.completedAt,
    suspended_at: null,
    suspended_total_seconds: 0,
    release_url: team.completedAt ? `https://${bp.slug}-demo.vercel.app` : null,
    lead_last_active_at: voting ? world.ago(9) : world.ago(world.between(0, 2)),
    version: 3,
    created_by: team.creator.userId,
    created_at: team.createdAt,
    updated_at: team.completedAt ?? world.ago(world.between(0, 2)),
  });
}

function addSeats(world, team) {
  for (const s of team.seats) {
    world.add('teams.seat', {
      id: s.id,
      team_id: team.id,
      role_code: s.role,
      ordinal: s.ordinal,
      desired: s.desired,
      desired_changed_at: s.desired ? at(team.createdAt, 1) : null,
      min_level: s.level,
      min_hours: Math.min(team.bp.hours, 8),
      stack: [],
      status: s.holder ? 'filled' : 'open',
      opened_at: s.holder ? null : at(team.createdAt, 0.1),
      version: s.holder ? 2 : 1,
    });
  }
}

function journal(world, team, type, actor, payload, when) {
  world.add('teams.team_event', {
    id: world.id(),
    team_id: team.id,
    type,
    actor_user_id: actor?.userId ?? null,
    payload,
    at: when,
  });
}

function addJournal(world, team) {
  const { creator } = team;
  journal(world, team, 'team_created', creator, { productTypeCode: team.bp.type }, team.createdAt);
  for (const s of team.seats) {
    journal(
      world,
      team,
      'seat_opened',
      creator,
      { seatId: s.id, roleCode: s.role, desired: s.desired },
      at(team.createdAt, 0.05),
    );
  }
  for (const m of team.members.filter((x) => !x.isLead)) {
    journal(
      world,
      team,
      'member_joined',
      m.person,
      { seatId: m.seat.id, roleCode: m.seat.role, via: m.seat.via },
      m.joinedAt,
    );
  }
  if (team.startedAt)
    journal(world, team, 'team_started', creator, { from: 'forming' }, team.startedAt);
}

/** Pending offers and requests that are waiting for an answer right now. */
function addOpenOffers(world, team) {
  const { bp } = team;
  if (bp.offerTo) {
    const seat = team.seats.find((s) => s.role === bp.offerTo.role && !s.holder);
    const person = world.person(bp.offerTo.person);
    const offer = pendingOffer(world, team, seat, person, 'lead_to_user', OFFER_MESSAGE);
    team.pendingOffer = { offer, person, seat };
  }
  if (bp.joinRequest) {
    const seat = team.seats.find((s) => s.role === bp.joinRequest && !s.holder);
    const person = world.pickHolder(
      bp.joinRequest,
      bp.status,
      new Set(team.members.map((m) => m.person.key)),
    );
    const offer = pendingOffer(world, team, seat, person, 'user_to_lead', JOIN_REQUEST_MESSAGE);
    team.pendingRequest = { offer, person, seat };
  }
}

function pendingOffer(world, team, seat, person, direction, message) {
  const createdAt = world.ago(world.between(0.2, 1.5));
  const offer = world.add('teams.seat_offer', {
    id: world.id(),
    team_id: team.id,
    seat_id: seat.id,
    user_id: person.userId,
    direction,
    status: 'pending',
    message,
    expires_at: new Date(createdAt.getTime() + OFFER_TTL_MS),
    created_at: createdAt,
    decided_at: null,
  });
  const actor = direction === 'lead_to_user' ? team.lead : person;
  const payload = { offerId: offer.id, seatId: seat.id, roleCode: seat.role, direction };
  journal(world, team, 'offer_created', actor, payload, createdAt);
  return offer;
}
