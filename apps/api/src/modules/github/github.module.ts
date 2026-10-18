import { Global, Module } from '@nestjs/common';
import { GithubClient } from './internal/client/github-client.js';
import { RateLimitGate } from './internal/client/rate-limit-gate.js';
import { RepositoryReader } from './internal/client/repository-reader.js';
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
import { AccountSyncService } from './internal/jobs/account-sync.service.js';
import { GithubSync } from './internal/jobs/github-sync.js';
import { RepoSyncService } from './internal/jobs/repo-sync.service.js';
import { SyncStateRepository } from './internal/repositories/sync-state.repository.js';
import { RepoChecksService } from './internal/services/repo-checks.service.js';
import { GithubWebhookProcessor } from './internal/jobs/github-webhook.processor.js';
import { WebhookSweeper } from './internal/jobs/webhook-sweeper.js';
import { ContributionEvents } from './internal/webhook/contribution-events.js';
import { DeliveryProcessor } from './internal/webhook/delivery-processor.service.js';
import { DeliveryRepository } from './internal/webhook/delivery.repository.js';
import { GithubOperations } from './internal/webhook/github-operations.js';
import { ItemEventsHandler } from './internal/webhook/item-events.handler.js';
import { ItemRepository } from './internal/webhook/item.repository.js';
import { LifecycleEventsHandler } from './internal/webhook/lifecycle-events.handler.js';
import { MemberAttribution } from './internal/webhook/member-attribution.service.js';
import { ReviewEventsHandler } from './internal/webhook/review-events.handler.js';
import { WebhookController } from './internal/webhook/webhook.controller.js';
import { WebhookReceiver } from './internal/webhook/webhook-receiver.service.js';

/**
 * Github module. S6-03: the GitHub App client (App JWT, installation tokens in Redis) and the
 * installation flow: createInstallationSession, githubSetupCallback, listAvailableRepositories.
 * S6-04: the binding of a repository (linkRepository, getRepository, unlinkRepository) and `GithubApi`.
 * S6-05: webhooks (receiveGithubWebhook, the `github-webhook` queue, the sweeper) and the events of contributions.
 * S6-06: the daily reconciliation `github-sync`, `repo_check`, `account_check`, and the checks `repo_final`,
 * `ci_workflow`, `pr_cross_review`.
 */
@Global()
@Module({
  controllers: [InstallationController, RepoController, WebhookController],
  providers: [
    GithubClient,
    RepositoryReader,
    RateLimitGate,
    SyncStateRepository,
    RepoChecksService,
    RepoSyncService,
    AccountSyncService,
    GithubSync,
    InstallationStateStore,
    InstallationRepository,
    InstallationSessionService,
    SetupCallbackService,
    AvailableRepositoriesService,
    RepoInspectionService,
    RepoLinkRepository,
    RepoLinkService,
    GithubFacade,
    GithubOperations,
    DeliveryRepository,
    ItemRepository,
    MemberAttribution,
    ContributionEvents,
    ItemEventsHandler,
    ReviewEventsHandler,
    LifecycleEventsHandler,
    DeliveryProcessor,
    WebhookReceiver,
    GithubWebhookProcessor,
    WebhookSweeper,
    { provide: GITHUB_API, useExisting: GithubFacade },
  ],
  exports: [GITHUB_API],
})
export class GithubModule {}
