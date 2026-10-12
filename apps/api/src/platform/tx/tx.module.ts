import { Global, Module } from '@nestjs/common';
import { LockService } from './locks.js';
import { TxHooks } from './tx-hooks.js';
import { TxRunner } from './tx-runner.js';

@Global()
@Module({
  providers: [TxHooks, TxRunner, LockService],
  exports: [TxHooks, TxRunner, LockService],
})
export class TxModule {}
