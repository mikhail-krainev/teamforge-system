import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import type { MultipartBody } from '../../../../platform/http/multipart.js';
import type { ProfileDto } from '../profile/profile.types.js';
import { ResumeConfirmService, type ResumeConfirmation } from './resume-confirm.service.js';
import type { ResumeDto } from './resume.repository.js';
import { ResumeService } from './resume.service.js';

/** uploadResume, getMyResume, confirmResumeFields, deleteResume (FR-PROF-02..05). */
@Controller('v1/me/resume')
export class ResumeController {
  constructor(
    @Inject(ResumeService) private readonly resumes: ResumeService,
    @Inject(ResumeConfirmService) private readonly confirmation: ResumeConfirmService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Post()
  @HttpCode(202)
  @Authz('uploadResume')
  upload(@Body() body: MultipartBody): Promise<ResumeDto> {
    return this.resumes.upload(requireUserId(this.cls), body);
  }

  @Get()
  @Authz('getMyResume')
  getMyResume(): Promise<ResumeDto> {
    return this.resumes.latest(requireUserId(this.cls));
  }

  @Post(':uploadId/confirmations')
  @HttpCode(200)
  @Authz('confirmResumeFields')
  confirm(
    @Param('uploadId') uploadId: string,
    @Body() body: ResumeConfirmation,
  ): Promise<ProfileDto> {
    return this.confirmation.confirm(requireUserId(this.cls), uploadId, body);
  }

  @Delete(':uploadId')
  @HttpCode(204)
  @Authz('deleteResume')
  async remove(@Param('uploadId') uploadId: string): Promise<void> {
    await this.resumes.delete(requireUserId(this.cls), uploadId);
  }
}
