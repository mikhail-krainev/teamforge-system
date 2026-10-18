import { Module } from '@nestjs/common';
import { GithubClient } from './internal/client/github-client.js';
import { AvailableRepositoriesService } from './internal/installation/available-repositories.service.js';
import { InstallationSessionService } from './internal/installation/installation-session.service.js';
import { InstallationStateStore } from './internal/installation/installation-state.store.js';
import { InstallationController } from './internal/installation/installation.controller.js';
import { InstallationRepository } from './internal/installation/installation.repository.js';
import { SetupCallbackService } from './internal/installation/setup-callback.service.js';

/**
 * Github module. S6-03: the GitHub App client (App JWT, installation tokens in Redis) and the
 * installation flow: createInstallationSession, githubSetupCallback, listAvailableRepositories.
 */
@Module({
  controllers: [InstallationController],
  providers: [
    GithubClient,
    InstallationStateStore,
    InstallationRepository,
    InstallationSessionService,
    SetupCallbackService,
    AvailableRepositoriesService,
  ],
  exports: [GithubClient],
})
export class GithubModule {}
