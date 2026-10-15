import { AutoAddEventsConsumer } from './jobs/auto-add-events.consumer.js';
import { AutoAddProcessor } from './jobs/auto-add.processor.js';
import { AutoAddRepository } from './repositories/auto-add.repository.js';
import { AutoAddScheduler } from './services/auto-add-scheduler.service.js';
import { AutoAddService } from './services/auto-add.service.js';

/** Auto-add from the queue (S4-05) and its `matching-auto-add` job; spread into `MatchingModule`. */
export const AUTO_ADD_PROVIDERS = [
  AutoAddRepository,
  AutoAddService,
  AutoAddScheduler,
  AutoAddProcessor,
  AutoAddEventsConsumer,
];
