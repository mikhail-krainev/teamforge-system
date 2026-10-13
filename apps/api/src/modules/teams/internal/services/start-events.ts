import { uuidv7 } from 'uuidv7';
import type { teamEvent } from '../schema/votes.js';

/** Journal types written by the project start and the status timers (FR-TEAM-10, FR-TEAM-27). */
export type StatusJournalType = 'team_started' | 'team_status_changed';

/** A journal row of a status change; `actorUserId` is null when a timer made the change. */
export function statusJournalRow(
  teamId: string,
  type: StatusJournalType,
  actorUserId: string | null,
  payload: Record<string, unknown>,
  at: Date,
): typeof teamEvent.$inferInsert {
  return { id: uuidv7(), teamId, type, actorUserId, payload, at };
}
