import type { Schema } from 'shared';
import { t, type MessageKey } from '@/i18n';

export type Profile = Schema<'Profile'>;
export type ProfileInput = Schema<'ProfileInput'>;
export type ProfileFields = Schema<'ProfileFields'>;
export type Level = Schema<'Level'>;
export type RolePref = ProfileFields['rolePrefs'] extends (infer R)[] | undefined ? R : never;

export const LIMITS = {
  nameMin: 2,
  nameMax: 60,
  hoursMin: 3,
  hoursMax: 40,
  stackMax: 30,
  rolesMax: 5,
  experienceMax: 10,
  listMax: 10,
  listItemMax: 200,
  titleMax: 120,
  descriptionMax: 2000,
  urlMax: 2048,
} as const;

export const LEVELS: readonly Level[] = ['beginner', 'junior', 'middle'];

export interface ExperienceDraft {
  title: string;
  description: string;
  from: string;
  to: string;
}

/** Form state: everything the user types is a string until validated. */
export interface ProfileDraft {
  displayName: string;
  timezone: string;
  hoursPerWeek: string;
  portfolioUrl: string;
  stack: string[];
  rolePrefs: { roleCode: string; level: Level }[];
  experience: ExperienceDraft[];
  strengths: string;
  weaknesses: string;
}

export function emptyDraft(timezone: string): ProfileDraft {
  return {
    displayName: '',
    timezone,
    hoursPerWeek: '10',
    portfolioUrl: '',
    stack: [],
    rolePrefs: [],
    experience: [],
    strengths: '',
    weaknesses: '',
  };
}

export function toDraft(profile: Profile): ProfileDraft {
  return {
    displayName: profile.displayName,
    timezone: profile.timezone,
    hoursPerWeek: String(profile.hoursPerWeek),
    portfolioUrl: profile.portfolioUrl ?? '',
    stack: [...profile.stack],
    rolePrefs: profile.rolePrefs.map((r) => ({ ...r })),
    experience: profile.experience.map((e) => ({
      title: e.title,
      description: e.description ?? '',
      from: e.from,
      to: e.to ?? '',
    })),
    strengths: profile.strengths.join('\n'),
    weaknesses: profile.weaknesses.join('\n'),
  };
}

/** One non-empty trimmed line per item. */
export function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Field path (`displayName`, `experience.0.title`) to message key. */
export type DraftErrors = Partial<Record<string, MessageKey>>;

function validateLines(text: string): MessageKey | undefined {
  const lines = splitLines(text);
  if (lines.length > LIMITS.listMax) return 'profile.errors.listTooLong';
  return lines.some((l) => l.length > LIMITS.listItemMax)
    ? 'profile.errors.itemTooLong'
    : undefined;
}

function validateUrl(value: string): MessageKey | undefined {
  const url = value.trim();
  if (url === '') return undefined;
  if (url.length > LIMITS.urlMax || !url.startsWith('https://')) return 'profile.errors.url';
  try {
    new URL(url);
    return undefined;
  } catch {
    return 'profile.errors.url';
  }
}

function validateExperience(items: ExperienceDraft[]): DraftErrors {
  const errors: DraftErrors = {};
  items.forEach((item, i) => {
    if (item.title.trim() === '') errors[`experience.${i}.title`] = 'profile.errors.required';
    else if (item.title.length > LIMITS.titleMax)
      errors[`experience.${i}.title`] = 'profile.errors.tooLong';
    if (item.from === '') errors[`experience.${i}.from`] = 'profile.errors.required';
    if (item.to !== '' && item.from !== '' && item.to < item.from) {
      errors[`experience.${i}.to`] = 'profile.errors.dateOrder';
    }
    if (item.description.length > LIMITS.descriptionMax) {
      errors[`experience.${i}.description`] = 'profile.errors.tooLong';
    }
  });
  return errors;
}

export function validateDraft(draft: ProfileDraft): DraftErrors {
  const errors: DraftErrors = {};
  const name = draft.displayName.trim();
  if (name.length < LIMITS.nameMin || name.length > LIMITS.nameMax) {
    errors.displayName = 'profile.errors.name';
  }
  if (draft.timezone.trim() === '') errors.timezone = 'profile.errors.required';
  const hours = Number(draft.hoursPerWeek);
  if (!Number.isInteger(hours) || hours < LIMITS.hoursMin || hours > LIMITS.hoursMax) {
    errors.hoursPerWeek = 'profile.errors.hours';
  }
  const urlError = validateUrl(draft.portfolioUrl);
  if (urlError) errors.portfolioUrl = urlError;
  if (draft.rolePrefs.length > LIMITS.rolesMax) errors.rolePrefs = 'profile.errors.tooManyRoles';
  if (draft.stack.length > LIMITS.stackMax) errors.stack = 'profile.errors.tooManyTags';
  if (draft.experience.length > LIMITS.experienceMax)
    errors.experience = 'profile.errors.tooManyItems';
  const strengths = validateLines(draft.strengths);
  if (strengths) errors.strengths = strengths;
  const weaknesses = validateLines(draft.weaknesses);
  if (weaknesses) errors.weaknesses = weaknesses;
  return { ...errors, ...validateExperience(draft.experience) };
}

/** Request body of `saveMyProfile`; call only after `validateDraft` found no errors. */
export function toInput(draft: ProfileDraft, version: number | null): ProfileInput {
  const url = draft.portfolioUrl.trim();
  return {
    displayName: draft.displayName.trim(),
    timezone: draft.timezone.trim(),
    hoursPerWeek: Number(draft.hoursPerWeek),
    ...(url ? { portfolioUrl: url } : { portfolioUrl: null }),
    stack: draft.stack,
    rolePrefs: draft.rolePrefs.map((r) => ({ roleCode: r.roleCode, level: r.level })),
    experience: draft.experience.map((e) => ({
      title: e.title.trim(),
      ...(e.description.trim() ? { description: e.description.trim() } : {}),
      from: e.from,
      to: e.to === '' ? null : e.to,
    })),
    strengths: splitLines(draft.strengths),
    weaknesses: splitLines(draft.weaknesses),
    version,
  };
}

export function levelLabel(level: Level): string {
  return t(`profile.level.${level}`);
}
