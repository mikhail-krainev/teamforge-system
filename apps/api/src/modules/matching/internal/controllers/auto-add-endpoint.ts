import {
  Controller,
  HttpCode,
  Inject,
  Injectable,
  Optional,
  Post,
  type OnModuleInit,
  type Provider,
  type Type,
} from '@nestjs/common';
import { AuthzRegistry } from '../../../../platform/authz/authz.registry.js';
import type { OperationSpec } from '../../../../platform/authz/contract-operations.js';
import { APP_CONFIG } from '../../../../platform/config/config.module.js';
import type { AppConfig } from '../../../../platform/config/config.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { Authz, NoIdempotency } from '../../../../platform/http/operation.decorator.js';
import { type AutoAddReport, AutoAddService } from '../services/auto-add.service.js';

/** Runtime-only operation, not part of the public contract. */
const RUN_AUTO_ADD: OperationSpec = {
  operationId: 'runMatchingAutoAddNow',
  method: 'post',
  path: '/v1/_test/matching/auto-add',
  authz: {
    actor: 'public',
    rule: 'exists only when NODE_ENV=test (loopback APP_ORIGIN): runs matching-auto-add now',
  },
  schemas: {},
};

/**
 * Runs one `matching-auto-add` pass inside the request and answers with its report (Playwright
 * slice 4, step 4). The same `AutoAddService.run()` the queue processor calls. Registered only when
 * the process starts with `NODE_ENV=test` (see `autoAddNowRoutes`); the handler checks the loaded
 * configuration again, so a production configuration answers 404 even if the class was wired.
 */
@Controller('v1/_test/matching')
export class AutoAddNowController {
  constructor(
    @Inject(AutoAddService) private readonly autoAdd: AutoAddService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('auto-add')
  @HttpCode(200)
  @NoIdempotency()
  @Authz('runMatchingAutoAddNow')
  async run(): Promise<AutoAddReport> {
    if (this.config.NODE_ENV !== 'test') throw new DomainError('NOT_FOUND', 404);
    return this.autoAdd.run();
  }
}

/** Gives the operation its `x-authz` to the registry of the HTTP process (the worker has none). */
@Injectable()
export class AutoAddNowOperations implements OnModuleInit {
  constructor(@Optional() @Inject(AuthzRegistry) private readonly registry?: AuthzRegistry) {}

  onModuleInit(): void {
    this.registry?.registerOperations([RUN_AUTO_ADD]);
  }
}

/** Controllers and providers of the test-only trigger: empty unless `nodeEnv` is `test`. */
export function autoAddNowRoutes(nodeEnv: string | undefined): {
  controllers: Type<unknown>[];
  providers: Provider[];
} {
  return nodeEnv === 'test'
    ? { controllers: [AutoAddNowController], providers: [AutoAddNowOperations] }
    : { controllers: [], providers: [] };
}
