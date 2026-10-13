import { StartController } from './controllers/start.controller.js';
import { MaxDurationScan } from './jobs/max-duration-scan.js';
import { StartService } from './services/start.service.js';

/** Controllers and providers of the project start and the max-duration timer (S3-09). */
export const START_CONTROLLERS = [StartController];
export const START_PROVIDERS = [StartService, MaxDurationScan];
