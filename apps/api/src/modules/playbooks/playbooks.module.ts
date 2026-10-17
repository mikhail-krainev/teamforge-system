import { Global, Module } from '@nestjs/common';
import { PlaybookController } from './internal/controllers/playbook.controller.js';
import { YamlBodyParser } from './internal/controllers/yaml-body-parser.js';
import { ProductTypeController } from './internal/controllers/product-type.controller.js';
import { PlaybookAdminService } from './internal/loader/playbook-admin.service.js';
import { AdminProbe } from './internal/read/admin-probe.js';
import { PlaybookDefinitions } from './internal/read/playbook-definitions.js';
import { PlaybookReader } from './internal/read/playbook-reader.js';
import { PlaybookReadService } from './internal/read/playbook-read.service.js';
import { PlaybooksFacade } from './internal/services/playbooks-facade.service.js';
import { PLAYBOOKS_API } from './public.js';

/** Playbooks: product types, playbooks as data (load, check, publish, read), platform templates. */
@Global()
@Module({
  controllers: [ProductTypeController, PlaybookController],
  providers: [
    PlaybooksFacade,
    { provide: PLAYBOOKS_API, useExisting: PlaybooksFacade },
    PlaybookReader,
    PlaybookDefinitions,
    PlaybookReadService,
    PlaybookAdminService,
    AdminProbe,
    YamlBodyParser,
  ],
  exports: [PLAYBOOKS_API],
})
export class PlaybooksModule {}
