import { Inject, Injectable } from '@nestjs/common';
import type { MatchingApi, RoleCode, RoleDemand, UserId } from '../../public.js';
import { DemandService } from '../demand/demand.service.js';
import { ApplicationRepository } from '../repositories/application.repository.js';

/** Implementation of `MatchingApi` (public.ts). */
@Injectable()
export class MatchingFacade implements MatchingApi {
  constructor(
    @Inject(ApplicationRepository) private readonly applications: ApplicationRepository,
    @Inject(DemandService) private readonly demand: DemandService,
  ) {}

  getDemand(roles: RoleCode[]): Promise<RoleDemand[]> {
    return this.demand.getDemand(roles);
  }

  async hasActiveApplication(userId: UserId): Promise<boolean> {
    return (await this.applications.findActiveByUser(userId)) !== undefined;
  }
}
