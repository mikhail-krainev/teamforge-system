export type Level = 'beginner' | 'junior' | 'middle';

export interface RolePref {
  roleCode: string;
  level: Level;
}

export interface ExperienceEntry {
  title: string;
  description?: string;
  from: string;
  to?: string | null;
}

/** Body of `saveMyProfile` after schema validation. */
export interface ProfileInput {
  displayName: string;
  timezone: string;
  hoursPerWeek: number;
  portfolioUrl?: string | null;
  stack: string[];
  rolePrefs: RolePref[];
  experience: ExperienceEntry[];
  strengths: string[];
  weaknesses: string[];
  version: number | null;
}

/** `Profile` of the contract: the owner's full view. */
export interface ProfileDto {
  userId: string;
  displayName: string;
  timezone: string;
  hoursPerWeek: number;
  portfolioUrl: string | null;
  stack: string[];
  rolePrefs: RolePref[];
  experience: ExperienceEntry[];
  strengths: string[];
  weaknesses: string[];
  version: number;
  updatedAt: string;
}

/** `PublicProfile` of the contract (FR-PROF-06): no weaknesses, version, e-mail or resume. */
export interface PublicProfileDto {
  userId: string;
  displayName: string;
  timezone: string;
  hoursPerWeek: number;
  portfolioUrl: string | null;
  stack: string[];
  rolePrefs: RolePref[];
  experience: ExperienceEntry[];
  strengths: string[];
  isDeleted: false;
}
