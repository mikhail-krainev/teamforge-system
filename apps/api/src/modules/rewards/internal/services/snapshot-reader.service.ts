import { Inject, Injectable } from '@nestjs/common';
import { TEAMS_API, type RosterMember, type TeamsApi } from '../../../teams/public.js';
import {
  type CompletionSnapshot,
  WORKSPACE_API,
  type WorkspaceApi,
} from '../../../workspace/public.js';

/**
 * The snapshot of the completion with `deficit_at_join` taken from the seat assignment of teams (FR-TEAM-25,
 * FR-REW-09). The flag is written once, when the person joins, and no demand change ever recomputes it, so reading
 * it when the credit is made gives the value of the joining; the copy in the snapshot is the same unless the
 * record of teams was corrected after the completion, and then the record of teams is the one that counts.
 */
@Injectable()
export class SnapshotReader {
  constructor(
    @Inject(WORKSPACE_API) private readonly workspace: WorkspaceApi,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
  ) {}

  async read(teamId: string): Promise<CompletionSnapshot> {
    const [snapshot, roster] = await Promise.all([
      this.workspace.getCompletionSnapshot(teamId),
      this.teams.getRoster(teamId),
    ]);
    return withLiveDeficits(snapshot, roster);
  }
}

/** Pure: the roles of each member of the snapshot with the flag of the live record (members not found keep theirs). */
export function withLiveDeficits(
  snapshot: CompletionSnapshot,
  roster: readonly RosterMember[],
): CompletionSnapshot {
  const live = new Map(
    roster.flatMap((m) =>
      m.roles.map((r) => [`${m.userId}|${r.roleCode}`, r.deficitAtJoin] as const),
    ),
  );
  return {
    ...snapshot,
    roster: {
      ...snapshot.roster,
      members: snapshot.roster.members.map((member) => ({
        ...member,
        roles: member.roles.map((r) => ({
          ...r,
          deficitAtJoin: live.get(`${member.userId}|${r.roleCode}`) ?? r.deficitAtJoin,
        })),
      })),
    },
  };
}
