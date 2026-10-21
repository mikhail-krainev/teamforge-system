import { Inject, Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import { TEAMS_API, type TeamsApi } from '../../../teams/public.js';
import { GithubClient, type UserInstallation } from '../client/github-client.js';
import { GithubError } from '../client/github-error.js';
import { InstallationStateStore } from './installation-state.store.js';
import { InstallationRepository } from './installation.repository.js';
import { REQUIRED_PERMISSIONS, type SetupOutcome } from './setup-redirect.js';

export interface SetupCallbackQuery {
  installation_id: number;
  setup_action?: 'install' | 'update' | 'request';
  state: string;
  code?: string | undefined;
}

const log = new Logger('GithubSetup');

const refused = (
  error: Extract<SetupOutcome, { ok: false }>['error'],
  teamId?: string,
): SetupOutcome => (teamId === undefined ? { ok: false, error } : { ok: false, error, teamId });

const hasPermission = (installation: UserInstallation, name: string): boolean => {
  const level = installation.permissions[name];
  return level === 'read' || level === 'write';
};

/**
 * githubSetupCallback (FR-GH-01, SEC-02, architecture 7.2; order of the checks: docs/research/
 * github-state-spike.md). The query holds `state` and `code`: neither is logged, stored or returned.
 */
@Injectable()
export class SetupCallbackService {
  constructor(
    @Inject(GithubClient) private readonly github: GithubClient,
    @Inject(InstallationStateStore) private readonly states: InstallationStateStore,
    @Inject(InstallationRepository) private readonly installations: InstallationRepository,
    @Inject(TEAMS_API) private readonly teams: TeamsApi,
    @Inject(AUTH_API) private readonly auth: AuthApi,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  async handle(userId: string, query: SetupCallbackQuery): Promise<SetupOutcome> {
    // Without the OAuth `code` nothing proves who installed (the installation_id can be forged).
    if (query.code === undefined || query.code === '') return refused('code_missing');
    // GETDEL: one use; a state of another user is burnt as well, the owner starts again.
    const state = await this.states.consume(query.state);
    if (state === null || state.userId !== userId) return refused('state_invalid');
    const { teamId } = state;
    try {
      await this.teams.assertLead(teamId, userId);
    } catch (error) {
      if (error instanceof DomainError && error.status === 403) return refused('not_lead', teamId);
      if (error instanceof DomainError && error.status === 404) return refused('state_invalid');
      throw error;
    }
    try {
      return await this.verifyAndGrant(userId, teamId, query.installation_id, query.code);
    } catch (error) {
      if (error instanceof GithubError) {
        log.warn(`setup callback stopped on a GitHub failure: ${error.kind}`);
        return refused(error.kind === 'bad_code' ? 'code_missing' : 'github_unavailable', teamId);
      }
      throw error;
    }
  }

  private async verifyAndGrant(
    userId: string,
    teamId: string,
    installationId: number,
    code: string,
  ): Promise<SetupOutcome> {
    const userToken = await this.github.exchangeUserCode(code);
    // The code proves the GitHub account that authorized, which must be the one the lead signed in with
    // (SEC-02): another account with access to someone else's organization would pass the checks below.
    const authorizedGithubId = await this.github.getAuthorizedUserId(userToken);
    const identity = await this.auth.getIdentity(userId);
    if (identity?.githubUserId == null || identity.githubUserId !== authorizedGithubId) {
      return refused('account_mismatch', teamId);
    }
    const installation = await this.github.findUserInstallation(userToken, installationId);
    // The user token has done its work: it is not kept anywhere.
    if (installation === null) return refused('installation_not_found', teamId);
    if (installation.suspended_at !== null) return refused('installation_suspended', teamId);
    if (!REQUIRED_PERMISSIONS.every((name) => hasPermission(installation, name))) {
      return refused('permissions_missing', teamId);
    }
    const now = this.clock.now();
    return this.tx.run(async () => {
      // The lead may have changed while GitHub was asked: the answer is final under lock #4.
      const team = await this.teams.lockTeam(teamId, 'share');
      if (team.leadUserId !== userId) return refused('not_lead', teamId);
      await this.installations.upsertInstallation(
        {
          installationId: installation.id,
          accountId: installation.account.id,
          accountLogin: installation.account.login,
          accountType: installation.account.type,
          status: 'active',
        },
        now,
      );
      await this.installations.grant(installation.id, teamId, userId, now);
      return { ok: true, teamId, installationId: installation.id } satisfies SetupOutcome;
    });
  }
}
