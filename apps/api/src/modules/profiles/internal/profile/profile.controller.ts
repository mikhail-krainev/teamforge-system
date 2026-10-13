import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { ProfileService } from './profile.service.js';
import type { ProfileDto, ProfileInput, PublicProfileDto } from './profile.types.js';

/** getMyProfile, saveMyProfile, getPublicProfile (FR-PROF-01). */
@Controller('v1')
export class ProfileController {
  constructor(
    @Inject(ProfileService) private readonly profiles: ProfileService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Get('me/profile')
  @Authz('getMyProfile')
  getMyProfile(): Promise<ProfileDto> {
    return this.profiles.getMine(requireUserId(this.cls));
  }

  @Put('me/profile')
  @Authz('saveMyProfile')
  saveMyProfile(@Body() body: ProfileInput): Promise<ProfileDto> {
    return this.profiles.save(requireUserId(this.cls), body);
  }

  @Get('users/:userId/profile')
  @Authz('getPublicProfile')
  getPublicProfile(@Param('userId') userId: string): Promise<PublicProfileDto> {
    return this.profiles.getPublic(userId);
  }
}
