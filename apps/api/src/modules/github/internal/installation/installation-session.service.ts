import { Inject, Injectable } from '@nestjs/common';
import type { Ok } from 'shared';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { GithubClient } from '../client/github-client.js';
import { GithubError } from '../client/github-error.js';
import { githubUnavailable } from './github-problems.js';
import { InstallationStateStore, STATE_TTL_SECONDS } from './installation-state.store.js';

/** createInstallationSession (FR-GH-01, architecture 7.2): the address where the lead installs the App. */
@Injectable()
export class InstallationSessionService {
  constructor(
    @Inject(GithubClient) private readonly github: GithubClient,
    @Inject(InstallationStateStore) private readonly states: InstallationStateStore,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  /** The caller is the lead of `teamId` (policy `team-lead`); the state remembers both. */
  async create(userId: string, teamId: string): Promise<Ok<'createInstallationSession'>> {
    if (!this.github.isConfigured()) throw githubUnavailable(new GithubError('not_configured'));
    const team = await this.teams.getTeamView(teamId);
    if (team === null) throw new DomainError('NOT_FOUND', 404);
    if (team.status === 'completed' || team.status === 'archived') {
      throw new DomainError('INVALID_STATE', 409);
    }
    const state = await this.states.issue({ teamId, userId });
    return {
      installUrl: this.github.installUrl(state),
      expiresAt: new Date(this.clock.now().getTime() + STATE_TTL_SECONDS * 1000).toISOString(),
    };
  }
}
