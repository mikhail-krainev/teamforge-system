// The living part around the teams: the queue, recommendations, the leader vote and notifications.
import { DAY_MS, HOUR_MS } from './world.mjs';
import { INSTALLATION_ID } from './build-work.mjs';

const QUEUE_SHARE = 0.75;
/** The showcase shows an average waiting time from this many matches on (matching demand-rules). */
const WAIT_MIN_SAMPLES = 5;
/** People already in one project may look for a second one. */
const BUSY_QUEUE_SHARE = 0.3;

export function buildInstallation(world) {
  world.add('github.gh_installation', {
    installation_id: INSTALLATION_ID,
    account_id: INSTALLATION_ID,
    account_login: 'teamforge-demo',
    account_type: 'Organization',
    status: 'active',
    updated_at: world.ago(100),
  });
}

/** People without an active project wait in the queue; so does the newcomer, for a second team. */
export function buildQueue(world) {
  const queued = new Map();
  const crowd = [...world.people.values()].filter((p) => !p.isDemo);
  const waiting = crowd.filter((p) => {
    const active = world.activeProjects.get(p.key) ?? 0;
    return active === 0
      ? world.chance(QUEUE_SHARE)
      : active === 1 && world.chance(BUSY_QUEUE_SHARE);
  });
  waiting.push(world.person('demo-newcomer'));
  for (const p of waiting) {
    const id = world.id();
    const enqueuedAt =
      p.key === 'demo-newcomer' ? world.ago(1.2) : world.ago(world.between(0.5, 25));
    const roles = p.roles.map(([r]) => r).slice(0, world.int(1, 2));
    queued.set(p.key, new Set(roles));
    world.add('matching.search_application', {
      id,
      user_id: p.userId,
      status: 'active',
      enqueued_at: enqueuedAt,
      paused_seconds: 0,
      fulfilled_at: null,
      fulfilled_seat_id: null,
      fulfilled_role_code: null,
      fulfilled_team_id: null,
      cancelled_at: null,
      restored_at: null,
      version: 1,
    });
    roles.forEach((role, i) =>
      world.add('matching.application_role', {
        application_id: id,
        role_code: role,
        priority: i + 1,
        added_at: enqueuedAt,
        is_active: true,
      }),
    );
  }
  addWaitHistory(world);
  return queued;
}

/** Older matches: the showcase averages waiting time per role over the last weeks. */
function addWaitHistory(world) {
  const roles = [
    'frontend',
    'backend',
    'pm',
    'designer',
    'qa',
    'devops',
    'product_analyst',
    'ba',
    'ml_engineer',
    'data_engineer',
    'mobile',
    'system_analyst',
  ];
  roles.forEach((role, i) => {
    for (let n = 0; n < WAIT_MIN_SAMPLES + (i % 4); n += 1) {
      const waitedDays =
        role === 'frontend' || role === 'backend' ? world.between(3, 14) : world.between(0.3, 4);
      world.add('matching.wait_sample', {
        id: world.id(),
        application_id: world.id(),
        role_code: role,
        waited_seconds: Math.round(waitedDays * 86_400),
        matched_at: world.ago(world.between(1, 28)),
      });
    }
  });
}

export function buildCandidateStats(world) {
  for (const p of world.people.values()) {
    const byRole = Map.groupBy(p.credits ?? [], (c) => c.role);
    for (const [role, list] of byRole)
      world.add('matching.candidate_stats', {
        user_id: p.userId,
        role_code: role,
        completed_count: list.length,
      });
  }
}

/** Recommendations for every open seat of a team that still looks for people. */
export function buildRecommendations(world, teams, queued) {
  for (const team of teams.filter((t) => t.bp.status !== 'completed')) {
    const inTeam = new Set(team.members.map((m) => m.person.key));
    for (const seat of team.seats.filter((s) => !s.holder)) {
      const fit = [...world.people.values()]
        .filter((p) => !inTeam.has(p.key) && !p.isAdmin && p.roles.some(([r]) => r === seat.role))
        .slice(0, 6);
      for (const p of fit) {
        const stack = Number(world.between(0.2, 1).toFixed(2));
        world.add('matching.match_candidate', {
          seat_id: seat.id,
          user_id: p.userId,
          team_id: team.id,
          role_code: seat.role,
          score: Number(world.between(0.52, 0.94).toFixed(3)),
          reasons: {
            role: true,
            stack,
            level: 1,
            timezone: Number(world.between(0.6, 1).toFixed(2)),
            availability: Number(world.between(0.5, 1).toFixed(2)),
            completedProjects: Math.min((p.credits?.length ?? 0) / 3, 1),
            matchedStackTags: p.stack.slice(0, 2),
            timezoneDiffHours: world.int(0, 3),
          },
          in_queue: queued.get(p.key)?.has(seat.role) ?? false,
          computed_at: world.ago(world.between(0.01, 0.5)),
        });
      }
    }
  }
}

/** Marshrut: the lead left three days ago, nominations are over and the members are voting. */
export function buildVote(world, team) {
  const leftAt = world.ago(3);
  const seat = team.seats.find((s) => s.role === team.bp.formerLead && !s.holder);
  addDeparture(world, team, seat, leftAt);
  const voteId = world.id();
  const openedAt = new Date(leftAt.getTime() + HOUR_MS);
  world.add('teams.leader_vote', {
    id: voteId,
    team_id: team.id,
    trigger: 'lead_left',
    status: 'voting',
    round: 1,
    opened_at: openedAt,
    phase_deadline: new Date(openedAt.getTime() + DAY_MS),
    voting_deadline: new Date(openedAt.getTime() + 4 * DAY_MS),
    extended: false,
    eligible_count: team.members.length,
    outcome: null,
    winner_user_id: null,
    random_tie_break: false,
    closed_at: null,
    version: 4,
  });
  addVoters(world, team, voteId, openedAt);
  addVoteJournal(world, team, { voteId, seat, leftAt, openedAt });
  for (const m of team.members) {
    const payload = { teamId: team.id, voteId };
    notify(world, {
      person: m.person,
      type: 'vote_opened',
      key: `vote_opened:${voteId}`,
      payload,
      at: openedAt,
    });
  }
}

/** The former lead's membership and seat, both ended when he left. */
function addDeparture(world, team, seat, leftAt) {
  const membershipId = world.id();
  const former = team.formerLead;
  world.add('teams.membership', {
    id: membershipId,
    team_id: team.id,
    user_id: former.userId,
    status: 'left',
    joined_via: 'creator',
    joined_at: team.createdAt,
    trial_until: null,
    trial_confirmed_at: null,
    application_id: null,
    left_at: leftAt,
    left_reason: 'left',
  });
  world.add('teams.seat_assignment', {
    id: world.id(),
    seat_id: seat.id,
    team_id: team.id,
    membership_id: membershipId,
    user_id: former.userId,
    role_code: seat.role,
    joined_via: 'creator',
    started_at: team.createdAt,
    ended_at: leftAt,
    deficit_at_join: false,
    deficit_open_seats: 0,
    deficit_queued: 3,
  });
}

/** Everybody may vote; two candidates agreed; half of the ballots are in. */
function addVoters(world, team, voteId, openedAt) {
  const [first, second, third] = team.members;
  for (const m of team.members) {
    world.add('teams.vote_eligible', {
      vote_id: voteId,
      user_id: m.person.userId,
      joined_at: m.joinedAt,
    });
  }
  for (const candidate of [first, second]) {
    world.add('teams.vote_candidate', {
      vote_id: voteId,
      user_id: candidate.person.userId,
      nominated_by: second.person.userId,
      consent_at: new Date(openedAt.getTime() + 5 * HOUR_MS),
      withdrawn_at: null,
      in_runoff: false,
    });
  }
  const ballots = [
    [first, first],
    [third, second],
  ];
  for (const [voter, choice] of ballots) {
    world.add('teams.vote_ballot', {
      vote_id: voteId,
      round: 1,
      voter_user_id: voter.person.userId,
      candidate_user_id: choice.person.userId,
      cast_at: new Date(openedAt.getTime() + 30 * HOUR_MS),
    });
  }
}

function addVoteJournal(world, team, { voteId, seat, leftAt, openedAt }) {
  const [first, second] = team.members;
  const event = (type, actor, payload, at) =>
    world.add('teams.team_event', {
      id: world.id(),
      team_id: team.id,
      type,
      actor_user_id: actor.userId,
      payload,
      at,
    });
  const candidate = { voteId, candidateUserId: first.person.userId };
  event('member_left', team.formerLead, { reason: 'left', seatIds: [seat.id] }, leftAt);
  event('vote_opened', team.formerLead, { voteId, trigger: 'lead_left' }, openedAt);
  event(
    'candidate_nominated',
    second.person,
    candidate,
    new Date(openedAt.getTime() + 2 * HOUR_MS),
  );
  event('candidacy_confirmed', first.person, candidate, new Date(openedAt.getTime() + 5 * HOUR_MS));
}

function notify(world, { person, type, key, payload, at, read = false }) {
  world.add('workspace.notification', {
    id: world.id(),
    user_id: person.userId,
    type,
    payload,
    dedupe_key: key,
    created_at: at,
    read_at: read ? new Date(at.getTime() + world.between(1, 20) * HOUR_MS) : null,
  });
}

/** What the bell shows: joins and starts for everybody, open offers, due stages and published reviews. */
export function buildNotifications(world, teams) {
  for (const team of teams) {
    notifyMembers(world, team);
    notifyOffers(world, team);
    addStageDue(world, team);
    if (team.bp.reviews === 'published') {
      const at = new Date(team.completedAt.getTime() + 14 * DAY_MS);
      const text = `Получены отзывы по проекту «${team.bp.name}»`;
      const payload = { teamId: team.id, teamName: team.bp.name, text };
      for (const m of team.members) {
        notify(world, {
          person: m.person,
          type: 'reviews_published',
          key: `reviews_published:${team.id}`,
          payload,
          at,
          read: true,
        });
      }
    }
  }
}

function notifyMembers(world, team) {
  const lead = team.members.find((m) => m.isLead)?.person;
  const old = (d) => world.now - d >= 2 * DAY_MS;
  for (const m of team.members.filter((x) => !x.isLead)) {
    const at = m.joinedAt;
    if (lead) {
      const payload = { teamId: team.id, userId: m.person.userId };
      notify(world, {
        person: lead,
        type: 'member_joined',
        key: `member_joined:${m.membershipId}`,
        payload,
        at,
        read: old(at),
      });
    }
    if (team.startedAt) {
      const payload = { teamId: team.id, seatId: null };
      notify(world, {
        person: m.person,
        type: 'team_started',
        key: `team_started:${team.id}`,
        payload,
        at: team.startedAt,
        read: true,
      });
    }
    if (m.seat.via === 'auto') {
      const payload = { teamId: team.id, seatId: m.seat.id };
      notify(world, {
        person: m.person,
        type: 'auto_added',
        key: `auto_added:${m.membershipId}`,
        payload,
        at,
        read: old(at),
      });
    }
  }
}

function notifyOffers(world, team) {
  const lead = team.members.find((m) => m.isLead)?.person;
  if (team.pendingOffer) {
    const { offer, person, seat } = team.pendingOffer;
    const payload = { offerId: offer.id, teamId: team.id, seatId: seat.id };
    notify(world, {
      person,
      type: 'seat_offer',
      key: `seat_offer:${offer.id}`,
      payload,
      at: offer.created_at,
    });
  }
  if (team.pendingRequest && lead) {
    const { offer, seat } = team.pendingRequest;
    const payload = { offerId: offer.id, teamId: team.id, seatId: seat.id };
    notify(world, {
      person: lead,
      type: 'join_request',
      key: `join_request:${offer.id}`,
      payload,
      at: offer.created_at,
    });
  }
}

function addStageDue(world, team) {
  if (team.bp.status !== 'active') return;
  const index = team.timeline.findIndex((t) => t.openedAt && !t.closedAt);
  const stage = team.playbook.stages[index];
  const due = team.timeline[index].openedAt.getTime() + stage.durationDays * DAY_MS;
  const left = due - world.now.getTime();
  const phase = left <= 0 ? 'overdue' : left <= 2 * DAY_MS ? 'soon' : null;
  if (phase === null) return;
  for (const m of team.members) {
    const payload = { teamId: team.id, stageOrdinal: stage.ordinal, phase };
    const key = `stage_due:${team.id}:${stage.ordinal}:${phase}`;
    notify(world, { person: m.person, type: 'stage_due', key, payload, at: world.ago(0.3) });
  }
}
