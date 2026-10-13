import { VoteController } from './controllers/vote.controller.js';
import { LeaderVoteRepository } from './repositories/leader-vote.repository.js';
import { VoteLeadReturnService } from './services/vote-lead-return.service.js';
import { VoteNominateService } from './services/vote-nominate.service.js';
import { VoteOpenService } from './services/vote-open.service.js';
import { VoteQueryService } from './services/vote-query.service.js';
import { VoteRequestService } from './services/vote-request.service.js';

/** Leader vote: opening and nomination (S3-07); ballots and deadlines follow in S3-08. */
export const VOTE_CONTROLLERS = [VoteController];
export const VOTE_PROVIDERS = [
  LeaderVoteRepository,
  VoteOpenService,
  VoteQueryService,
  VoteRequestService,
  VoteNominateService,
  VoteLeadReturnService,
];
