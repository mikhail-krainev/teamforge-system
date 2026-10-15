import { Module } from '@nestjs/common';
import { ApplicationController } from './internal/controllers/application.controller.js';
import { ApplicationRepository } from './internal/repositories/application.repository.js';
import { ApplicationService } from './internal/services/application.service.js';
import { MatchingFacade } from './internal/services/matching-facade.service.js';
import { MATCHING_API } from './public.js';

/**
 * Matching: the search queue application (S4-02). Demand and the `DeficitPort` binding (S4-03),
 * recommendations (S4-04) and auto-add (S4-05) are registered by their own tasks.
 */
@Module({
  controllers: [ApplicationController],
  providers: [
    ApplicationRepository,
    ApplicationService,
    MatchingFacade,
    { provide: MATCHING_API, useExisting: MatchingFacade },
  ],
  exports: [MATCHING_API],
})
export class MatchingModule {}
