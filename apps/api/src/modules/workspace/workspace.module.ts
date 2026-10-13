import { Module } from '@nestjs/common';
import { NotificationController } from './internal/controllers/notification.controller.js';
import { NotificationConsumer } from './internal/events/notification.consumer.js';
import { RealtimeRelayConsumer } from './internal/events/realtime-relay.consumer.js';
import { RealtimeGateway } from './internal/realtime/realtime.gateway.js';
import { NotificationRepository } from './internal/repositories/notification.repository.js';
import { NotificationService } from './internal/services/notification.service.js';

/**
 * Workspace module. S3-10: notifications (list, read marks, event handlers, e-mail) and the
 * WebSocket gateway with its Redis relay. Stages, checklist and files arrive in slice 5.
 */
@Module({
  controllers: [NotificationController],
  providers: [
    NotificationRepository,
    NotificationService,
    NotificationConsumer,
    RealtimeRelayConsumer,
    RealtimeGateway,
  ],
})
export class WorkspaceModule {}
