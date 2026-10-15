import { t, type MessageKey } from '@/i18n';
import type { Level, SeatInput, TeamCreate } from './api';

export const LIMITS = {
  nameMin: 3,
  nameMax: 80,
  descriptionMax: 4000,
  hoursMin: 3,
  hoursMax: 40,
  seatsMax: 12,
  seatCountMax: 12,
  stackMax: 30,
} as const;

export const LEVELS: readonly Level[] = ['beginner', 'junior', 'middle'];

export function levelLabel(level: Level): string {
  return t(`teams.level.${level}`);
}

/** A seat row of the form; numbers stay strings until validated. */
export interface SeatDraft {
  roleCode: string;
  minLevel: Level;
  minHours: string;
  desired: boolean;
  count: string;
}

export interface TeamDraft {
  name: string;
  description: string;
  timezone: string;
  hoursPerWeek: string;
  productTypeCode: string;
  seats: SeatDraft[];
}

/** Error text key per field id suffix (`name`, `seat-0-minHours`, ...). */
export type DraftErrors = Record<string, MessageKey>;

export function emptySeat(): SeatDraft {
  return { roleCode: '', minLevel: 'junior', minHours: '10', desired: false, count: '1' };
}

export function emptyTeamDraft(timezone: string): TeamDraft {
  return {
    name: '',
    description: '',
    timezone,
    hoursPerWeek: '10',
    productTypeCode: '',
    seats: [],
  };
}

function parseInteger(value: string): number | null {
  const text = value.trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

function inRange(value: string, min: number, max: number): boolean {
  const n = parseInteger(value);
  return n !== null && n >= min && n <= max;
}

export function validateSeat(seat: SeatDraft, prefix: string): DraftErrors {
  const errors: DraftErrors = {};
  if (seat.roleCode === '') errors[`${prefix}-roleCode`] = 'teams.errors.roleRequired';
  if (!inRange(seat.minHours, LIMITS.hoursMin, LIMITS.hoursMax)) {
    errors[`${prefix}-minHours`] = 'teams.errors.hours';
  }
  if (!inRange(seat.count, 1, LIMITS.seatCountMax))
    errors[`${prefix}-count`] = 'teams.errors.count';
  return errors;
}

export function validateTeamDraft(draft: TeamDraft): DraftErrors {
  const errors: DraftErrors = {};
  const name = draft.name.trim();
  if (name.length < LIMITS.nameMin || name.length > LIMITS.nameMax) {
    errors.name = 'teams.errors.name';
  }
  if (draft.description.length > LIMITS.descriptionMax) {
    errors.description = 'teams.errors.descriptionTooLong';
  }
  if (draft.productTypeCode === '') errors.productTypeCode = 'teams.errors.productType';
  if (draft.timezone.trim() === '') errors.timezone = 'teams.errors.required';
  if (!inRange(draft.hoursPerWeek, LIMITS.hoursMin, LIMITS.hoursMax)) {
    errors.hoursPerWeek = 'teams.errors.hours';
  }
  draft.seats.forEach((seat, index) => Object.assign(errors, validateSeat(seat, `seat-${index}`)));
  const total = draft.seats.reduce((sum, seat) => sum + (parseInteger(seat.count) ?? 1), 0);
  if (total > LIMITS.seatsMax) errors.seats = 'teams.errors.seatsTooMany';
  return errors;
}

export function toSeatInput(seat: SeatDraft): SeatInput {
  return {
    roleCode: seat.roleCode,
    desired: seat.desired,
    minLevel: seat.minLevel,
    minHours: Number(seat.minHours),
    stack: [],
    count: Number(seat.count),
  };
}

export function toTeamCreate(draft: TeamDraft): TeamCreate {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    timezone: draft.timezone,
    hoursPerWeek: Number(draft.hoursPerWeek),
    productTypeCode: draft.productTypeCode,
    ...(draft.seats.length > 0 ? { seats: draft.seats.map(toSeatInput) } : {}),
  };
}

/** Field ids in visual order, used to focus the first invalid one. */
export function firstInvalidId(errors: DraftErrors, order: readonly string[]): string | undefined {
  return order.find((id) => id in errors);
}
