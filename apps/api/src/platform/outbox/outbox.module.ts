import { Global, Module } from '@nestjs/common';
import { EventConsumers } from './event-consumers.js';
import { InboxService } from './inbox.service.js';
import { OutboxRelay } from './outbox-relay.js';
import { OutboxService } from './outbox.service.js';

/** Producer side (api and worker): OutboxService, consumer registry, relay, inbox. */
@Global()
@Module({
  providers: [OutboxService, EventConsumers, InboxService, OutboxRelay],
  exports: [OutboxService, EventConsumers, InboxService, OutboxRelay],
})
export class OutboxModule {}
