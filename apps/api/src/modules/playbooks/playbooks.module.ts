import { Global, Module } from '@nestjs/common';
import { ProductTypeController } from './internal/controllers/product-type.controller.js';
import { PlaybooksFacade } from './internal/services/playbooks-facade.service.js';
import { PLAYBOOKS_API } from './public.js';

/** Playbooks: product types and published playbooks (minimum for slice 3; the rest in slice 5). */
@Global()
@Module({
  controllers: [ProductTypeController],
  providers: [PlaybooksFacade, { provide: PLAYBOOKS_API, useExisting: PlaybooksFacade }],
  exports: [PLAYBOOKS_API],
})
export class PlaybooksModule {}
