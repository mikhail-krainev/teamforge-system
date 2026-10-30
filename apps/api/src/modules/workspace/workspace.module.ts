import { Global, Module } from '@nestjs/common';
import { DEPARTURE_ITEMS_PORT, TEAM_LIFECYCLE_PORT } from '../teams/public.js';
import { StageTransitionController } from './internal/controllers/stage-transition.controller.js';
import { StageDueNotify } from './internal/jobs/stage-due-notify.js';
import { ParticipationService } from './internal/services/participation.service.js';
import { TransitionRepository } from './internal/repositories/transition.repository.js';
import { StageTransitionService } from './internal/services/stage-transition.service.js';
import { ArtifactController } from './internal/controllers/artifact.controller.js';
import {
  ArtifactFileRemovalConsumer,
  OrphanArtifactSweeper,
} from './internal/events/artifact-file-removal.js';
import { ArtifactRepository } from './internal/repositories/artifact.repository.js';
import { ArtifactService } from './internal/services/artifact.service.js';
import { ArtifactStorage } from '../../platform/storage/artifact-storage.js';
import { ItemController } from './internal/controllers/item.controller.js';
import { LinkCheckSweep } from './internal/jobs/link-check-sweep.js';
import { LinkCheckRepository } from './internal/repositories/link-check.repository.js';
import { LinkResultService } from './internal/services/link-result.service.js';
import { ContributionConsumer } from './internal/events/contribution.consumer.js';
import { ItemContributionConsumer } from './internal/contribution/item-contribution.consumer.js';
import { RelabelService } from './internal/contribution/relabel.service.js';
import { FeedController } from './internal/feed/feed.controller.js';
import { FeedRepository } from './internal/feed/feed.repository.js';
import { FeedService } from './internal/feed/feed.service.js';
import { ContributionRepository } from './internal/repositories/contribution.repository.js';
import { RouteMembersConsumer } from './internal/events/route-members.consumer.js';
import { StepSignalsConsumer } from './internal/events/step-signals.consumer.js';
import { StageSuspensionConsumer } from './internal/events/stage-suspension.consumer.js';
import { ItemRepository } from './internal/repositories/item.repository.js';
import { DepartureItemsService } from './internal/services/departure-items.service.js';
import { FallbackService } from './internal/services/fallback.service.js';
import { ItemAssignService } from './internal/services/item-assign.service.js';
import { ItemGate } from './internal/services/item-gate.js';
import { ItemService } from './internal/services/item.service.js';
import { ReviewRepository } from './internal/repositories/review.repository.js';
import { ReviewService } from './internal/services/review.service.js';
import { StageController } from './internal/controllers/stage.controller.js';
import { RouteRepository } from './internal/repositories/route.repository.js';
import { RouteQueryService } from './internal/services/route-query.service.js';
import { TeamLifecycleService } from './internal/services/team-lifecycle.service.js';
import { NotificationController } from './internal/controllers/notification.controller.js';
import { NotificationConsumer } from './internal/events/notification.consumer.js';
import { RealtimeRelayConsumer } from './internal/events/realtime-relay.consumer.js';
import { RealtimeGateway } from './internal/realtime/realtime.gateway.js';
import { NotificationRepository } from './internal/repositories/notification.repository.js';
import { NotificationService } from './internal/services/notification.service.js';
import { CompletionController } from './internal/controllers/completion.controller.js';
import { ReleaseCheckRecorder } from './internal/events/release-check.recorder.js';
import { CompletionCheckProcessor } from './internal/jobs/completion-check.processor.js';
import { CompletionCheckSweep } from './internal/jobs/completion-check-sweep.js';
import { CompletionRepository } from './internal/repositories/completion.repository.js';
import { CompletionCheckService } from './internal/services/completion-check.service.js';
import { CompletionService } from './internal/services/completion.service.js';
import { LinkChecks } from './internal/services/link-checks.js';
import { ReleaseTargetService } from './internal/services/release-target.service.js';
import { AntifraudRepository } from './internal/repositories/antifraud.repository.js';
import { WorkspaceFacade } from './internal/services/workspace-facade.service.js';
import { WorkspaceOperations } from './internal/authz/workspace-operations.js';
import { CompletedProjects } from './internal/services/completed-projects.port.js';
import { COMPLETED_PROJECTS_PORT } from '../profiles/public.js';
import { WORKSPACE_API } from './public.js';

/**
 * Workspace module. S3-10: notifications (list, read marks, event handlers, e-mail) and the
 * WebSocket gateway with its Redis relay. S5-04: the route of a project (stages, checklist) and
 * the `TeamLifecyclePort` that opens it. S5-05: item writes (version, links), executors, fallback steps and the departure of a member. S5-06: artifact files (upload, signed download link, deletion, orphan cleanup). S5-08: stage transition, participation confirmations and the `stage-due-notify` timer. S5-09: the verdict of the `link-checker` on saved links and the sweep that repairs a lost check. S6-05: contributions from GitHub events (`github.contribution_detected` and `_revoked`) and the real-time signal `contribution.recorded`. S6-08: the check of readiness to complete (`auto-checks` worker, sweep), `completeProject` (T6), the page of results, the first look at the release and `WorkspaceApi`. S6-07: the feed, the summary, the role of a contribution (`relabelContribution`) and contributions of artifacts and rituals.
 *
 * Global because teams injects `TEAM_LIFECYCLE_PORT` and may not import workspace (architecture
 * 2.2): this module is the one place where the port is bound.
 */
@Global()
@Module({
  controllers: [
    NotificationController,
    StageController,
    ItemController,
    StageTransitionController,
    ArtifactController,
    FeedController,
    CompletionController,
  ],
  providers: [
    RouteRepository,
    ItemRepository,
    ItemGate,
    ArtifactStorage,
    ArtifactRepository,
    ArtifactService,
    ArtifactFileRemovalConsumer,
    OrphanArtifactSweeper,
    TransitionRepository,
    StageTransitionService,
    ParticipationService,
    StageDueNotify,
    ItemService,
    ReviewRepository,
    ReviewService,
    ItemAssignService,
    FallbackService,
    RouteMembersConsumer,
    ContributionRepository,
    ContributionConsumer,
    ItemContributionConsumer,
    FeedRepository,
    FeedService,
    RelabelService,
    StageSuspensionConsumer,
    StepSignalsConsumer,
    WorkspaceOperations,
    CompletionRepository,
    AntifraudRepository,
    LinkChecks,
    ReleaseTargetService,
    ReleaseCheckRecorder,
    CompletionCheckService,
    CompletionService,
    CompletionCheckProcessor,
    CompletionCheckSweep,
    WorkspaceFacade,
    { provide: WORKSPACE_API, useExisting: WorkspaceFacade },
    CompletedProjects,
    { provide: COMPLETED_PROJECTS_PORT, useExisting: CompletedProjects },
    LinkCheckRepository,
    LinkResultService,
    LinkCheckSweep,
    DepartureItemsService,
    { provide: DEPARTURE_ITEMS_PORT, useExisting: DepartureItemsService },
    RouteQueryService,
    TeamLifecycleService,
    { provide: TEAM_LIFECYCLE_PORT, useExisting: TeamLifecycleService },
    NotificationRepository,
    NotificationService,
    NotificationConsumer,
    RealtimeRelayConsumer,
    RealtimeGateway,
  ],
  exports: [TEAM_LIFECYCLE_PORT, DEPARTURE_ITEMS_PORT, WORKSPACE_API, COMPLETED_PROJECTS_PORT],
})
export class WorkspaceModule {}
