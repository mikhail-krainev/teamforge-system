import { Module } from '@nestjs/common';
import { DisputeService } from './internal/admin/dispute.service.js';
import { FraudCaseService } from './internal/admin/fraud-case.service.js';
import { AdminController } from './internal/controllers/admin.controller.js';
import { RewardsController } from './internal/controllers/rewards.controller.js';
import { CompletionConsumer } from './internal/events/completion.consumer.js';
import { RewardsDeletionConsumer } from './internal/events/deletion.consumer.js';
import { RewardsJobs } from './internal/jobs/rewards-jobs.js';
import { RewardsFacade } from './internal/read/rewards-facade.service.js';
import { RewardsReadService } from './internal/read/rewards-read.service.js';
import { AwardRepository } from './internal/repositories/award.repository.js';
import { CounterRepository } from './internal/repositories/counter.repository.js';
import { CreditRepository } from './internal/repositories/credit.repository.js';
import { CreditRunRepository } from './internal/repositories/credit-run.repository.js';
import { FraudRepository } from './internal/repositories/fraud.repository.js';
import { AccountVerdicts } from './internal/services/account-verdicts.service.js';
import { CreditApplier } from './internal/services/credit-applier.service.js';
import { CreditRunScan } from './internal/services/credit-run-scan.service.js';
import { CreditRunService } from './internal/services/credit-run.service.js';
import { CreditService } from './internal/services/credit.service.js';
import { FraudFactsService } from './internal/services/fraud-facts.service.js';
import { PendingRecheckService } from './internal/services/pending-recheck.service.js';
import { SnapshotReader } from './internal/services/snapshot-reader.service.js';
import { REWARDS_API } from './public.js';

/**
 * Rewards module (slice 7): the credit run of a completed project and its cooling (S7-02), the anti-fraud rules
 * (S7-03), the credit transaction and the awards (S7-04), the queue of manual review and the disputes (S7-05),
 * the reads of awards and counters (S7-06). `RewardsApi` is the facade other modules may use (`REWARDS_API`).
 */
@Module({
  controllers: [RewardsController, AdminController],
  providers: [
    CreditRunRepository,
    CreditRepository,
    CounterRepository,
    AwardRepository,
    FraudRepository,
    AccountVerdicts,
    SnapshotReader,
    FraudFactsService,
    CreditApplier,
    CreditRunService,
    CreditService,
    CreditRunScan,
    PendingRecheckService,
    FraudCaseService,
    DisputeService,
    RewardsReadService,
    RewardsFacade,
    { provide: REWARDS_API, useExisting: RewardsFacade },
    CompletionConsumer,
    RewardsDeletionConsumer,
    RewardsJobs,
  ],
  exports: [REWARDS_API],
})
export class RewardsModule {}
