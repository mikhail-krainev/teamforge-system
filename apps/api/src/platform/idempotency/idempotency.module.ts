import { Global, Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service.js';
import { IdempotencyStore } from './idempotency.store.js';

@Global()
@Module({
  providers: [IdempotencyStore, IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
