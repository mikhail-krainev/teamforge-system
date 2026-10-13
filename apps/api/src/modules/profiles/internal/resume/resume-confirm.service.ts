import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../../platform/clock/clock.js';
import { DomainError } from '../../../../platform/errors/domain-error.js';
import { TxRunner } from '../../../../platform/tx/tx-runner.js';
import { ProfileRepository } from '../profile/profile.repository.js';
import { ProfileService } from '../profile/profile.service.js';
import type { ProfileDto, ProfileInput } from '../profile/profile.types.js';
import { ResumeRepository } from './resume.repository.js';
import { ResumeService } from './resume.service.js';

/** `ProfileFields` of the contract: any subset of the profile, none of it applied before confirmation. */
export type ConfirmedFields = Partial<Omit<ProfileInput, 'version'>>;

export interface ResumeConfirmation {
  confirmedFields: ConfirmedFields;
  keepFile: boolean;
  profileVersion: number | null;
}

const REQUIRED: (keyof ConfirmedFields)[] = [
  'displayName',
  'timezone',
  'hoursPerWeek',
  'stack',
  'rolePrefs',
  'experience',
  'strengths',
  'weaknesses',
];

/** Without a profile a confirmation has to carry everything a profile needs. */
function assertComplete(fields: ConfirmedFields): void {
  const errors = REQUIRED.filter((name) => fields[name] === undefined).map((name) => ({
    pointer: `/confirmedFields/${name}`,
    code: 'required_for_new_profile',
    message: 'A new profile needs this field',
  }));
  if (errors.length > 0) throw new DomainError('VALIDATION_FAILED', 422, { errors });
}

function mergedInput(
  current: ProfileDto | undefined,
  fields: ConfirmedFields,
  version: number | null,
): ProfileInput {
  if (current === undefined) assertComplete(fields);
  const base: ConfirmedFields = current ?? {};
  return {
    displayName: fields.displayName ?? base.displayName ?? '',
    timezone: fields.timezone ?? base.timezone ?? '',
    hoursPerWeek: fields.hoursPerWeek ?? base.hoursPerWeek ?? 0,
    portfolioUrl:
      fields.portfolioUrl !== undefined ? fields.portfolioUrl : (base.portfolioUrl ?? null),
    stack: fields.stack ?? base.stack ?? [],
    rolePrefs: fields.rolePrefs ?? base.rolePrefs ?? [],
    experience: fields.experience ?? base.experience ?? [],
    strengths: fields.strengths ?? base.strengths ?? [],
    weaknesses: fields.weaknesses ?? base.weaknesses ?? [],
    version,
  };
}

/** `confirmResumeFields`: the user's confirmed fields, and only those, reach the profile (FR-PROF-04). */
@Injectable()
export class ResumeConfirmService {
  constructor(
    @Inject(ResumeRepository) private readonly resumes: ResumeRepository,
    @Inject(ProfileRepository) private readonly profiles: ProfileRepository,
    @Inject(ProfileService) private readonly profileService: ProfileService,
    @Inject(ResumeService) private readonly resumeService: ResumeService,
    @Inject(TxRunner) private readonly tx: TxRunner,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  async confirm(userId: string, uploadId: string, body: ResumeConfirmation): Promise<ProfileDto> {
    const saved = await this.tx.run(async () => {
      const upload = await this.resumes.lockOwn(uploadId, userId);
      if (upload === undefined) throw new DomainError('NOT_FOUND', 404);
      if (upload.status !== 'done' || upload.confirmedAt !== null) {
        throw new DomainError('INVALID_STATE', 409);
      }
      const current = await this.profiles.find(userId);
      if ((current?.version ?? null) !== body.profileVersion) {
        throw new DomainError('VERSION_CONFLICT', 409, current ? { current: { ...current } } : {});
      }
      const profile = await this.profileService.save(
        userId,
        mergedInput(current, body.confirmedFields, body.profileVersion),
      );
      await this.resumes.markConfirmed(uploadId, body.keepFile, this.clock.now());
      // Same transaction: the file cannot outlive the reference to it (S2CR-01).
      if (!body.keepFile) await this.resumeService.requestFileRemoval(userId, upload.storageKey);
      return profile;
    });
    return saved;
  }
}
