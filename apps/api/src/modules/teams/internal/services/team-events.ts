import { uuidv7 } from 'uuidv7';
import type { NewOutboxEvent } from '../../../../platform/outbox/outbox.types.js';
import { TEAMS_MODULE } from '../../public.js';
import type { teamEvent } from '../schema/votes.js';

/** Types written to `teams.team_event` (the journal shown by `listTeamEvents`). */
export type JournalType =
  | 'team_created'
  | 'team_updated'
  | 'seat_opened'
  | 'seat_updated'
  | 'seat_desired_changed'
  | 'seat_closed'
  | 'member_joined'
  | 'offer_created';

/** A journal row; payloads carry identifiers and flags only (names are resolved when read). */
export function journalRow(
  teamId: string,
  type: JournalType,
  actorUserId: string,
  payload: Record<string, unknown>,
  at: Date,
): typeof teamEvent.$inferInsert {
  return { id: uuidv7(), teamId, type, actorUserId, payload, at };
}

/** Outbox event of the teams module; the aggregate is the team unless stated otherwise. */
export function teamsEvent(
  type: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): NewOutboxEvent {
  return { module: TEAMS_MODULE, type, aggregateId, payload };
}
