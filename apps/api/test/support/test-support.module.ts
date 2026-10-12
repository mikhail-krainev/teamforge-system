import { Global, Module } from '@nestjs/common';
import { SESSION_AUTHENTICATOR } from '../../src/platform/authz/actor-policies.js';
import { EXTRA_OPERATIONS } from '../../src/platform/authz/authz.registry.js';
import { TEST_OPERATIONS } from './test-operations.js';
import { TestSessionAuthenticator } from './test-session.authenticator.js';
import { TestSupportController } from './test-support.controller.js';

/**
 * Infrastructure probes used by integration tests (idempotency, versioned writes, rate limit) and
 * the header-based test session. Imported ONLY by the test bootstrap (`createTestApp`); it is not
 * referenced from `src/` and `tsconfig.build.json` compiles `src/` alone, so the production image
 * cannot contain it.
 */
@Global()
@Module({
  controllers: [TestSupportController],
  providers: [
    { provide: SESSION_AUTHENTICATOR, useClass: TestSessionAuthenticator },
    { provide: EXTRA_OPERATIONS, useValue: TEST_OPERATIONS },
  ],
  exports: [SESSION_AUTHENTICATOR, EXTRA_OPERATIONS],
})
export class TestSupportModule {}
