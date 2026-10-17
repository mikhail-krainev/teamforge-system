import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Body } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import type { MultipartBody } from '../../../../platform/http/multipart.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { ArtifactService } from '../services/artifact.service.js';

/** uploadArtifactFile, getArtifactDownloadUrl, deleteArtifactFile (FR-WORK-05). */
@Controller('v1/teams/:teamId/checklist-items/:itemId/files')
export class ArtifactController {
  constructor(
    @Inject(ArtifactService) private readonly artifacts: ArtifactService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Post()
  @Authz('uploadArtifactFile')
  upload(
    @Param('teamId') teamId: string,
    @Param('itemId') itemId: string,
    @Body() body: MultipartBody,
  ): Promise<Ok<'uploadArtifactFile'>> {
    return this.artifacts.upload(requireUserId(this.cls), teamId, itemId, body);
  }

  @Get(':fileId/download-url')
  @Authz('getArtifactDownloadUrl')
  downloadUrl(
    @Param('teamId') teamId: string,
    @Param('itemId') itemId: string,
    @Param('fileId') fileId: string,
  ): Promise<Ok<'getArtifactDownloadUrl'>> {
    return this.artifacts.downloadUrl(teamId, itemId, fileId);
  }

  @Delete(':fileId')
  @HttpCode(204)
  @Authz('deleteArtifactFile')
  async remove(
    @Param('teamId') teamId: string,
    @Param('itemId') itemId: string,
    @Param('fileId') fileId: string,
  ): Promise<void> {
    await this.artifacts.remove(requireUserId(this.cls), teamId, itemId, fileId);
  }
}
