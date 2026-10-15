import { TrialController } from './controllers/trial.controller.js';
import { TrialExpireScheduler } from './jobs/trial-expire.js';
import { TrialRepository } from './repositories/trial.repository.js';
import { TrialService } from './services/trial.service.js';

/** The trial period of auto-added members (S4-06); spread into `TeamsModule`. */
export const TRIAL_CONTROLLERS = [TrialController];
export const TRIAL_PROVIDERS = [TrialRepository, TrialService, TrialExpireScheduler];
