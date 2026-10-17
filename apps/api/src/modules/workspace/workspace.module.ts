import { Global, Module } from '@nestjs/common';
import { DEPARTURE_ITEMS_PORT, TEAM_LIFECYCLE_PORT } from '../teams/public.js';
import { StageTransitionController } from './internal/controllers/stage-transition.controller.js';
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
import { RouteMembersConsumer } from './internal/events/route-members.consumer.js';
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

/**
 * Workspace module. S3-10: notifications (list, read marks, event handlers, e-mail) and the
 * WebSocket gateway with its Redis relay. S5-04: the route of a project (stages, checklist) and
 * the `TeamLifecyclePort` that opens it. S5-05: item writes (version, links), executors, fallback steps and the departure of a member. S5-06: artifact files (upload, signed download link, deletion, orphan cleanup).
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
    StageTransitionService,
    ItemService,
    ReviewRepository,
    ReviewService,
    ItemAssignService,
    FallbackService,
    RouteMembersConsumer,
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
  exports: [TEAM_LIFECYCLE_PORT, DEPARTURE_ITEMS_PORT],
})
export class WorkspaceModule {}
