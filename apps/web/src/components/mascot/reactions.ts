import type { MessageKey } from '@/i18n';

export type Reaction =
  | 'idle'
  | 'sleep'
  | 'perk'
  | 'tilt'
  | 'jump'
  | 'spin'
  | 'celebrate'
  | 'blush'
  | 'surprised'
  | 'wave'
  | 'dizzy';

export type Gaze = { x: -1 | 0 | 1; y: -1 | 0 | 1 };

export const CENTER: Gaze = { x: 0, y: 0 };

/** Click reactions in the order they are played; the cycle repeats. */
export const CLICK_CYCLE: readonly Reaction[] = [
  'jump',
  'wave',
  'spin',
  'blush',
  'celebrate',
  'surprised',
];

/** How long each reaction lasts before the Yeti goes back to idle. */
export const REACTION_MS: Record<Reaction, number> = {
  idle: 0,
  sleep: 0,
  perk: 650,
  tilt: 700,
  jump: 800,
  spin: 800,
  celebrate: 1200,
  blush: 1000,
  surprised: 800,
  wave: 1000,
  dizzy: 1200,
};

export const BUBBLE_KEYS: Partial<Record<Reaction, MessageKey>> = {
  jump: 'mascot.bubble.jump',
  wave: 'mascot.bubble.wave',
  celebrate: 'mascot.bubble.celebrate',
  blush: 'mascot.bubble.blush',
  surprised: 'mascot.bubble.surprised',
  dizzy: 'mascot.bubble.dizzy',
};

export const RAPID_CLICKS = 5;
export const RAPID_WINDOW_MS = 2000;
export const PERK_DISTANCE_PX = 160;
export const WAKE_DISTANCE_PX = 320;
export const GAZE_DEAD_ZONE_PX = 24;
/** Pointer speed (px per ms) that counts as leaving in a hurry. */
export const FAST_LEAVE_SPEED = 1.2;
export const SLEEP_AFTER_MS = 25_000;
