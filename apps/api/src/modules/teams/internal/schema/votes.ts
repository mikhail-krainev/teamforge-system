import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tstz } from '../../../../platform/db/schema/columns.js';
import { teamsSchema } from '../../../../platform/db/schema/module-schemas.js';
import { team } from './teams.js';

/** Leader vote (architecture 5.5, 8). At most one open vote per team (CC-4). */
export const leaderVote = teamsSchema.table(
  'leader_vote',
  {
    id: uuid('id').primaryKey(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => team.id),
    trigger: text('trigger').notNull(),
    status: text('status').notNull(),
    round: smallint('round').notNull().default(1),
    openedAt: tstz('opened_at').notNull(),
    phaseDeadline: tstz('phase_deadline'),
    votingDeadline: tstz('voting_deadline').notNull(),
    extended: boolean('extended').notNull().default(false),
    eligibleCount: smallint('eligible_count').notNull(),
    outcome: text('outcome'),
    winnerUserId: uuid('winner_user_id'),
    randomTieBreak: boolean('random_tie_break').notNull().default(false),
    closedAt: tstz('closed_at'),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    check(
      'leader_vote_trigger_check',
      sql`${t.trigger} IN ('lead_left','lead_deleted','lead_inactive')`,
    ),
    check(
      'leader_vote_status_check',
      sql`${t.status} IN ('nominating','voting','runoff','confirming','offering','closed','cancelled')`,
    ),
    check('leader_vote_round_check', sql`${t.round} IN (1,2)`),
    check(
      'leader_vote_outcome_check',
      sql`${t.outcome} IN ('elected','appointed_senior','sole_member','suspended','archived','cancelled_lead_returned')`,
    ),
    uniqueIndex('leader_vote_open_uq')
      .on(t.teamId)
      .where(sql`${t.status} NOT IN ('closed','cancelled')`),
    index('leader_vote_deadline_idx')
      .on(t.phaseDeadline)
      .where(sql`${t.status} NOT IN ('closed','cancelled')`),
  ],
);

export const voteEligible = teamsSchema.table(
  'vote_eligible',
  {
    voteId: uuid('vote_id')
      .notNull()
      .references(() => leaderVote.id),
    userId: uuid('user_id').notNull(),
    joinedAt: tstz('joined_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.voteId, t.userId], name: 'vote_eligible_pkey' })],
);

export const voteCandidate = teamsSchema.table(
  'vote_candidate',
  {
    voteId: uuid('vote_id')
      .notNull()
      .references(() => leaderVote.id),
    userId: uuid('user_id').notNull(),
    nominatedBy: uuid('nominated_by').notNull(),
    consentAt: tstz('consent_at'),
    withdrawnAt: tstz('withdrawn_at'),
    inRunoff: boolean('in_runoff').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.voteId, t.userId], name: 'vote_candidate_pkey' })],
);

export const voteBallot = teamsSchema.table(
  'vote_ballot',
  {
    voteId: uuid('vote_id')
      .notNull()
      .references(() => leaderVote.id),
    round: smallint('round').notNull(),
    voterUserId: uuid('voter_user_id').notNull(),
    candidateUserId: uuid('candidate_user_id').notNull(),
    castAt: tstz('cast_at').notNull(),
  },
  (t) => [
    // CC-4: one ballot per person and round.
    primaryKey({ columns: [t.voteId, t.round, t.voterUserId], name: 'vote_ballot_pkey' }),
    index('vote_ballot_tally_idx').on(t.voteId, t.round, t.candidateUserId),
  ],
);

/** Winner confirmation or an offer to the senior member. */
export const voteOffer = teamsSchema.table(
  'vote_offer',
  {
    id: uuid('id').primaryKey(),
    voteId: uuid('vote_id')
      .notNull()
      .references(() => leaderVote.id),
    userId: uuid('user_id').notNull(),
    kind: text('kind').notNull(),
    ordinal: smallint('ordinal').notNull(),
    status: text('status').notNull(),
    offeredAt: tstz('offered_at').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    answeredAt: tstz('answered_at'),
  },
  (t) => [
    check('vote_offer_kind_check', sql`${t.kind} IN ('winner_confirmation','senior_offer')`),
    check(
      'vote_offer_status_check',
      sql`${t.status} IN ('offered','accepted','declined','expired')`,
    ),
    unique('vote_offer_vote_user_kind_uq').on(t.voteId, t.userId, t.kind),
    uniqueIndex('vote_offer_pending_uq')
      .on(t.voteId)
      .where(sql`${t.status} = 'offered'`),
  ],
);

/** A request to start a vote because the lead is inactive (C-15). */
export const voteRequest = teamsSchema.table(
  'vote_request',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => team.id),
    userId: uuid('user_id').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId], name: 'vote_request_pkey' })],
);

export const teamEvent = teamsSchema.table(
  'team_event',
  {
    id: uuid('id').primaryKey(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => team.id),
    type: text('type').notNull(),
    actorUserId: uuid('actor_user_id'),
    payload: jsonb('payload').notNull(),
    at: tstz('at').notNull(),
  },
  (t) => [index('team_event_team_idx').on(t.teamId, t.at.desc(), t.id.desc())],
);
