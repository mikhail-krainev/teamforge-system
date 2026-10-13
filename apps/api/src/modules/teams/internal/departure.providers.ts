import { DepartureController } from './controllers/departure.controller.js';
import { TeamsTimersProcessor } from './jobs/departure-default.js';
import { LEADER_VOTE_OPEN_PORT } from './ports/leader-vote-open.port.js';
import { DepartureRepository } from './repositories/departure.repository.js';
import { DepartureLeaveService } from './services/departure-leave.service.js';
import { DepartureService } from './services/departure.service.js';
import { VoteOpenService } from './services/vote-open.service.js';

/** Leaving a team, the lead's decision and the `timers` worker (S3-06). */
export const DEPARTURE_CONTROLLERS = [DepartureController];
export const DEPARTURE_PROVIDERS = [
  DepartureRepository,
  DepartureLeaveService,
  DepartureService,
  TeamsTimersProcessor,
  { provide: LEADER_VOTE_OPEN_PORT, useExisting: VoteOpenService },
];
