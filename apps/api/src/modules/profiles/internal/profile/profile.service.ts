import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { OutboxService } from '../../../../platform/outbox/outbox.service.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { AUTH_API, type AuthApi } from '../../../auth/public.js';
import { PROFILES_MODULE } from '../../public.js';
import { profileErrors } from './profile-rules.js';
import { ProfileRepository } from './profile.repository.js';
import type { ProfileDto, ProfileInput, PublicProfileDto } from './profile.types.js';

/** My profile and the public profile of others (FR-PROF-01). */
@Injectable()
export class ProfileService {
  constructor(
    @Inject(ProfileRepository) private readonly repository: ProfileRepository,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(AUTH_API) private readonly auth: AuthApi,
  ) {}

  async getMine(userId: string): Promise<ProfileDto> {
    const found = await this.repository.find(userId);
    if (found === undefined) throw new DomainError('NOT_FOUND', 404);
    return found;
  }

  /** Visible to any signed-in user; deleted or deleting accounts and users without a profile -> 404. */
  async getPublic(userId: string): Promise<PublicProfileDto> {
    const identity = await this.auth.getIdentity(userId);
    const found = identity?.status === 'active' ? await this.repository.find(userId) : undefined;
    if (found === undefined) throw new DomainError('NOT_FOUND', 404);
    return {
      userId: found.userId,
      displayName: found.displayName,
      timezone: found.timezone,
      hoursPerWeek: found.hoursPerWeek,
      portfolioUrl: found.portfolioUrl,
      stack: found.stack,
      rolePrefs: found.rolePrefs,
      experience: found.experience,
      strengths: found.strengths,
      isDeleted: false,
    };
  }

  /**
   * Whole-profile save with optimistic locking: `version` null creates, a number updates. The row
   * lock of the profile makes parallel writers of one version queue up; only the first matches.
   */
  save(userId: string, input: ProfileInput): Promise<ProfileDto> {
    return this.tx.run(async () => {
      const state = await this.repository.catalogState(userId, input);
      const errors = profileErrors(input, state);
      if (errors.length > 0) throw new DomainError('VALIDATION_FAILED', 422, { errors });
      const now = this.clock.now();
      const won =
        input.version === null
          ? await this.repository.insertIfAbsent(userId, input, now)
          : await this.repository.updateIfVersion(userId, input, input.version, now);
      if (!won) throw await this.conflict(userId);
      await this.repository.replaceChildren(userId, input);
      await this.outbox.publish({
        module: PROFILES_MODULE,
        type: 'profile_updated',
        aggregateId: userId,
        payload: { userId },
      });
      return this.getMine(userId);
    });
  }

  private async conflict(userId: string): Promise<DomainError> {
    const current = await this.repository.find(userId);
    return new DomainError('VERSION_CONFLICT', 409, current ? { current: { ...current } } : {});
  }
}
