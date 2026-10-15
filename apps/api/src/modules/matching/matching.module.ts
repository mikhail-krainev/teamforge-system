import { Global, Module } from '@nestjs/common';
import { DEFICIT_PORT } from '../teams/public.js';
import { AUTO_ADD_PROVIDERS } from './internal/auto-add.providers.js';
import { ApplicationController } from './internal/controllers/application.controller.js';
import { autoAddNowRoutes } from './internal/controllers/auto-add-endpoint.js';
import { DemandCache } from './internal/demand/demand-cache.js';
import { DemandCacheConsumer } from './internal/demand/demand.consumer.js';
import { DemandController } from './internal/demand/demand.controller.js';
import { DemandRepository } from './internal/demand/demand.repository.js';
import { DemandService } from './internal/demand/demand.service.js';
import { MatchingDeficitPort } from './internal/demand/deficit.port.js';
import { ApplicationRepository } from './internal/repositories/application.repository.js';
import { ApplicationService } from './internal/services/application.service.js';
import { MatchingFacade } from './internal/services/matching-facade.service.js';
import { RESTORE_PROVIDERS } from './internal/restore.providers.js';
import { RECOMMEND_CONTROLLERS, RECOMMEND_PROVIDERS } from './internal/recommend.providers.js';
import { MATCHING_API } from './public.js';

/** The test-only trigger of `matching-auto-add`: present only in a process started with NODE_ENV=test. */
const AUTO_ADD_NOW = autoAddNowRoutes(process.env.NODE_ENV);

/**
 * Matching: the search queue application (S4-02), the demand showcase and the `DeficitPort`
 * (S4-03), recommendations (S4-04), auto-add from the queue (S4-05), return of an excluded person (S4-06).
 *
 * Global because teams injects `DEFICIT_PORT` and may not import matching (architecture 2.2, Р-1):
 * this module is the one place where the port is bound.
 */
@Global()
@Module({
  controllers: [
    ApplicationController,
    DemandController,
    ...RECOMMEND_CONTROLLERS,
    ...AUTO_ADD_NOW.controllers,
  ],
  providers: [
    ...RECOMMEND_PROVIDERS,
    ...AUTO_ADD_PROVIDERS,
    ...RESTORE_PROVIDERS,
    ...AUTO_ADD_NOW.providers,
    ApplicationRepository,
    ApplicationService,
    DemandRepository,
    DemandCache,
    DemandService,
    DemandCacheConsumer,
    MatchingDeficitPort,
    { provide: DEFICIT_PORT, useExisting: MatchingDeficitPort },
    MatchingFacade,
    { provide: MATCHING_API, useExisting: MatchingFacade },
  ],
  exports: [MATCHING_API, DEFICIT_PORT],
})
export class MatchingModule {}
