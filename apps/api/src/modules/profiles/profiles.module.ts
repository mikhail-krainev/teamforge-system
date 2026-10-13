import { Global, Module } from '@nestjs/common';
import { CatalogController } from './internal/catalog/catalog.controller.js';
import { CatalogRepository } from './internal/catalog/catalog.repository.js';
import { CatalogService } from './internal/catalog/catalog.service.js';
import { ProfilesDeletionConsumer } from './internal/events/deletion.consumer.js';
import { ProfileController } from './internal/profile/profile.controller.js';
import { ProfileRepository } from './internal/profile/profile.repository.js';
import { ProfileService } from './internal/profile/profile.service.js';
import { ProfilesFacade } from './internal/profile/profiles-facade.service.js';
import { ResumeConfirmService } from './internal/resume/resume-confirm.service.js';
import {
  OrphanObjectsSweeper,
  ResumeFileRemovalConsumer,
} from './internal/resume/resume-file-removal.js';
import { ResumeParseClient } from './internal/resume/resume-parse.client.js';
import { ResumePipeline } from './internal/resume/resume-pipeline.js';
import { ResumeStorage } from './internal/resume/resume-storage.js';
import { ResumeController } from './internal/resume/resume.controller.js';
import { ResumeRepository } from './internal/resume/resume.repository.js';
import { ResumeService } from './internal/resume/resume.service.js';
import { PROFILES_API } from './public.js';

/** Profiles: catalogs (S2-08), profile (S2-09), resume and its isolated parsing (S2-10). */
@Global()
@Module({
  controllers: [CatalogController, ProfileController, ResumeController],
  providers: [
    CatalogRepository,
    CatalogService,
    ProfileRepository,
    ProfileService,
    ProfilesFacade,
    { provide: PROFILES_API, useExisting: ProfilesFacade },
    ResumeRepository,
    ResumeStorage,
    ResumeService,
    ResumeConfirmService,
    ResumeParseClient,
    ResumePipeline,
    ProfilesDeletionConsumer,
    ResumeFileRemovalConsumer,
    OrphanObjectsSweeper,
  ],
  exports: [PROFILES_API],
})
export class ProfilesModule {}
