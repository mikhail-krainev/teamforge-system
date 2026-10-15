import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { teamEvent } from '../schema/votes.js';

export type TeamEventRow = typeof teamEvent.$inferSelect;

export interface EventCursor {
  at: Date;
  id: string;
}

/** `teams.team_event`: the log of changes (FR-TEAM-03, FR-TEAM-21). */
@Injectable()
export class TeamEventRepository {
  constructor(@Inject(TxRunner) private readonly tx: TxRunner) {}

  async insertMany(rows: (typeof teamEvent.$inferInsert)[]): Promise<void> {
    if (rows.length > 0) await this.tx.tx.insert(teamEvent).values(rows);
  }

  /** Who held the lead when the vote opened (`vote_opened` is written before the lead is cleared). */
  async leadAtOpening(teamId: string, voteId: string): Promise<string | null> {
    const rows = await this.tx.tx
      .select({ actor: teamEvent.actorUserId })
      .from(teamEvent)
      .where(
        and(
          eq(teamEvent.teamId, teamId),
          eq(teamEvent.type, 'vote_opened'),
          sql`${teamEvent.payload}->>'voteId' = ${voteId}`,
        ),
      )
      .limit(1);
    return rows[0]?.actor ?? null;
  }

  /** Newest first, keyset `(at, id)`; served by `team_event_team_idx`. */
  list(teamId: string, after: EventCursor | undefined, limit: number): Promise<TeamEventRow[]> {
    return this.tx.tx
      .select()
      .from(teamEvent)
      .where(
        and(
          eq(teamEvent.teamId, teamId),
          after === undefined
            ? undefined
            : sql`(${teamEvent.at}, ${teamEvent.id}) < (${after.at.toISOString()}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(teamEvent.at), desc(teamEvent.id))
      .limit(limit);
  }
}
