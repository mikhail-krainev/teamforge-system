import { Inject, Injectable } from '@nestjs/common';
import type { MatchingApi, UserId } from '../../public.js';
import { ApplicationRepository } from '../repositories/application.repository.js';

/** Implementation of `MatchingApi` (public.ts). */
@Injectable()
export class MatchingFacade implements MatchingApi {
  constructor(
    @Inject(ApplicationRepository) private readonly applications: ApplicationRepository,
  ) {}

  async hasActiveApplication(userId: UserId): Promise<boolean> {
    return (await this.applications.findActiveByUser(userId)) !== undefined;
  }
}
