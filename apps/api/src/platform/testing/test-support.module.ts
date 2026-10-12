import { Module } from '@nestjs/common';
import { TestSupportController } from './test-support.controller.js';
import { TestUserGuard } from './test-user.guard.js';

/**
 * Infrastructure probes used by integration tests (idempotency, versioned writes, rate limit).
 * Only imported when NODE_ENV=test; never part of a production build graph at runtime.
 */
@Module({ controllers: [TestSupportController], providers: [TestUserGuard] })
export class TestSupportModule {}
