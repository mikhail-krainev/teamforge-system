import { Inject, Injectable } from '@nestjs/common';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';

/** Maps GitHub accounts to the active members of a team (FR-GH-05). Read before the transaction. */
@Injectable()
export class MemberAttribution {
  constructor(
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
  ) {}

  /**
   * The member of the team behind each GitHub id. An account that belongs to nobody, or to somebody
   * who is not a member of this team, is absent: another team's member earns nothing here (SEC-06).
   */
  async membersByGithubId(teamId: string, githubIds: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(githubIds)];
    if (unique.length === 0) return new Map();
    const users = await this.auth.findUserIdsByGithubIds(unique);
    if (users.size === 0) return new Map();
    const roster = new Set((await this.teams.getRoster(teamId)).map((member) => member.userId));
    return new Map([...users].filter(([, userId]) => roster.has(userId)));
  }
}
