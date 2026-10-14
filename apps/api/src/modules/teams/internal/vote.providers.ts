import { VoteDeadlineScan } from './jobs/vote-deadline-scan.js';
import { VoteTimers } from './jobs/vote-deadline.js';
import { VoteController } from './controllers/vote.controller.js';
import { LeaderVoteRepository } from './repositories/leader-vote.repository.js';
import { VoteBallotService } from './services/vote-ballot.service.js';
import { VoteDeadlineService } from './services/vote-deadline.service.js';
import { VoteFlowService } from './services/vote-flow.service.js';
import { VoteLeadReturnService } from './services/vote-lead-return.service.js';
import { VoteNominateService } from './services/vote-nominate.service.js';
import { VoteLock } from './services/vote-lock.js';
import { VoteOfferService } from './services/vote-offer.service.js';
import { VoteOpenService } from './services/vote-open.service.js';
import { VoteQueryService } from './services/vote-query.service.js';
import { VoteRequestService } from './services/vote-request.service.js';

/** Leader vote: opening and nomination (S3-07), ballots, deadlines and the offer (S3-08). */
export const VOTE_CONTROLLERS = [VoteController];
export const VOTE_PROVIDERS = [
  LeaderVoteRepository,
  VoteOpenService,
  VoteQueryService,
  VoteRequestService,
  VoteNominateService,
  VoteLeadReturnService,
  VoteLock,
  VoteTimers,
  VoteFlowService,
  VoteBallotService,
  VoteOfferService,
  VoteDeadlineService,
  VoteDeadlineScan,
];
