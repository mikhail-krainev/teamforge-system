import { Module } from '@nestjs/common';
import { CatalogController } from './internal/catalog/catalog.controller.js';
import { CatalogRepository } from './internal/catalog/catalog.repository.js';
import { CatalogService } from './internal/catalog/catalog.service.js';

/** Profiles: catalogs (S2-08); profile (S2-09) and resume (S2-10) join later. */
@Module({
  controllers: [CatalogController],
  providers: [CatalogRepository, CatalogService],
})
export class ProfilesModule {}
