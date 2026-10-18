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
 */
@Global()
@Module({
  controllers: [InstallationController, RepoController, WebhookController],
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
