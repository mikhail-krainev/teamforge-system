import { Global, Module } from '@nestjs/common';
import { GithubClient } from './internal/client/github-client.js';
import { AvailableRepositoriesService } from './internal/installation/available-repositories.service.js';
import { InstallationSessionService } from './internal/installation/installation-session.service.js';
import { InstallationStateStore } from './internal/installation/installation-state.store.js';
import { InstallationController } from './internal/installation/installation.controller.js';
import { InstallationRepository } from './internal/installation/installation.repository.js';
import { GITHUB_API } from './public.js';
import { GithubFacade } from './internal/services/github-facade.service.js';
import { RepoController } from './internal/services/repo.controller.js';
import { RepoInspectionService } from './internal/services/repo-inspection.service.js';
import { RepoLinkRepository } from './internal/services/repo-link.repository.js';
import { RepoLinkService } from './internal/services/repo-link.service.js';
import { SetupCallbackService } from './internal/installation/setup-callback.service.js';

/**
 * Github module. S6-03: the GitHub App client (App JWT, installation tokens in Redis) and the
 * installation flow: createInstallationSession, githubSetupCallback, listAvailableRepositories.
 * S6-04: the binding of a repository (linkRepository, getRepository, unlinkRepository) and `GithubApi`.
 */
@Global()
@Module({
  controllers: [InstallationController, RepoController],
  providers: [
    GithubClient,
    InstallationStateStore,
    InstallationRepository,
    InstallationSessionService,
    SetupCallbackService,
    AvailableRepositoriesService,
    RepoInspectionService,
    RepoLinkRepository,
    RepoLinkService,
    GithubFacade,
    { provide: GITHUB_API, useExisting: GithubFacade },
  ],
  exports: [GITHUB_API],
})
export class GithubModule {}
