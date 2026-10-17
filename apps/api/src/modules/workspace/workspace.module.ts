import { Global, Module } from '@nestjs/common';
import { TEAM_LIFECYCLE_PORT } from '../teams/public.js';
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
 * the `TeamLifecyclePort` that opens it. Item writes and files arrive in S5-05 and S5-06.
 *
 * Global because teams injects `TEAM_LIFECYCLE_PORT` and may not import workspace (architecture
 * 2.2): this module is the one place where the port is bound.
 */
@Global()
@Module({
  controllers: [NotificationController, StageController],
  providers: [
    RouteRepository,
    RouteQueryService,
    TeamLifecycleService,
    { provide: TEAM_LIFECYCLE_PORT, useExisting: TeamLifecycleService },
    NotificationRepository,
    NotificationService,
    NotificationConsumer,
    RealtimeRelayConsumer,
    RealtimeGateway,
  ],
  exports: [TEAM_LIFECYCLE_PORT],
})
export class WorkspaceModule {}
