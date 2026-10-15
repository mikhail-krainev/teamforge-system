import { ApplicationRestoreService } from './events/application-restore.service.js';
import { MemberExcludedConsumer } from './events/member-excluded.consumer.js';
import { RestoreRepository } from './events/restore.repository.js';

/** Return of an excluded person to the queue (S4-06, FR-MATCH-08); spread into `MatchingModule`. */
export const RESTORE_PROVIDERS = [
  RestoreRepository,
  ApplicationRestoreService,
  MemberExcludedConsumer,
];
