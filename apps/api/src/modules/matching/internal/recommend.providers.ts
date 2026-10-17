import { RecommendController } from './controllers/recommend.controller.js';
import { CandidateStatsConsumer } from './jobs/candidate-stats.consumer.js';
import { RecommendEventsConsumer } from './jobs/recommend-events.consumer.js';
import { RecommendRecomputeAll } from './jobs/recommend-recompute-all.js';
import { RecommendRecomputeProcessor } from './jobs/recommend-recompute.processor.js';
import { CandidateStatsRepository } from './repositories/candidate-stats.repository.js';
import { RecommendRepository } from './repositories/recommend.repository.js';
import { RecommendScheduler } from './services/recommend-scheduler.service.js';
import { RecommendService } from './services/recommend.service.js';
import { ScoreRecomputeService } from './services/score-recompute.service.js';

/** Recommendations and the `matching-recompute` job (S4-04); spread into `MatchingModule`. */
export const RECOMMEND_CONTROLLERS = [RecommendController];
export const RECOMMEND_PROVIDERS = [
  RecommendRepository,
  CandidateStatsRepository,
  RecommendService,
  RecommendScheduler,
  ScoreRecomputeService,
  RecommendRecomputeProcessor,
  RecommendRecomputeAll,
  RecommendEventsConsumer,
  CandidateStatsConsumer,
];
