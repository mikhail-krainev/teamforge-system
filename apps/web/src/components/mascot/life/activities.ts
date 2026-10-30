import { WIPE_HAND, type BodyFrame } from './sprites';
import type { PropDraw } from './types';

/** Things he does on his own while standing on a block. Walking about is a walk track instead. */
export type ActivityName = 'wipe' | 'read' | 'campfire' | 'guitar' | 'ask' | 'peek' | 'sleep';

export interface ActivityFrame {
  frame: BodyFrame;
  props: readonly PropDraw[];
}

interface ActivitySpec {
  /** [min, max] in ms; ask waits for the reader and ends through the chat instead. */
  duration: readonly [number, number];
  weight: number;
  sample: (ms: number) => ActivityFrame;
}

const alternate = <T>(ms: number, stepMs: number, a: T, b: T): T =>
  Math.floor(ms / stepMs) % 2 ? b : a;

const WIPE_STEP_MS = 240;
const READ_PAGE_MS = 2400;
const FIRE_STEP_MS = 130;
const STRUM_STEP_MS = 280;
const NOTE_EVERY_MS = 900;

function wipe(ms: number): ActivityFrame {
  const frame = alternate(ms, WIPE_STEP_MS, 'wipe1', 'wipe2' as const);
  const [dx, dy] = WIPE_HAND[frame];
  const shine: PropDraw[] =
    ms > 1800 ? [{ name: 'sparkle', dx: dx + 1, dy: dy - 4, className: 'life-prop-pop' }] : [];
  return { frame, props: [{ name: 'rag', dx: dx - 1, dy: dy - 1 }, ...shine] };
}

function campfire(ms: number): ActivityFrame {
  const fire = (['fire1', 'fire2', 'fire3'] as const)[Math.floor(ms / FIRE_STEP_MS) % 3] ?? 'fire1';
  // The fire is lit a moment after he sits down.
  const flame: PropDraw[] = ms > 700 ? [{ name: fire }] : [];
  return { frame: 'sit', props: [{ name: 'logs' }, ...flame] };
}

function guitar(ms: number): ActivityFrame {
  const notes: PropDraw[] = [
    // Keyed by index so CSS restarts the float for every new note.
    {
      name: 'note',
      className: `life-prop-note life-prop-note-${Math.floor(ms / NOTE_EVERY_MS) % 2}`,
    },
  ];
  return { frame: alternate(ms, STRUM_STEP_MS, 'sitGuitar1', 'sitGuitar2' as const), props: notes };
}

export const ACTIVITIES: Record<ActivityName, ActivitySpec> = {
  wipe: { duration: [3200, 4200], weight: 12, sample: wipe },
  read: {
    duration: [8000, 13000],
    weight: 12,
    sample: (ms) => ({
      frame: alternate(ms, READ_PAGE_MS, 'sitRead1', 'sitRead2' as const),
      props: [],
    }),
  },
  campfire: { duration: [10000, 15000], weight: 10, sample: campfire },
  guitar: { duration: [8000, 12000], weight: 12, sample: guitar },
  ask: { duration: [Infinity, Infinity], weight: 7, sample: () => ({ frame: 'talk', props: [] }) },
  peek: {
    duration: [3600, 4400],
    weight: 3,
    sample: () => ({ frame: 'peek', props: [{ name: 'magnifier' }] }),
  },
  sleep: {
    duration: [Infinity, Infinity],
    weight: 0,
    sample: () => ({ frame: 'sleep', props: [{ name: 'zzz', className: 'life-prop-float' }] }),
  },
};

export function durationOf(name: ActivityName): number {
  const [min, max] = ACTIVITIES[name].duration;
  return min + Math.random() * (max - min);
}

/** Weighted pick among the allowed activities, never the same one twice in a row. */
export function pickActivity(allowed: readonly ActivityName[], last: ActivityName | null) {
  const pool = allowed.filter((name) => name !== last && ACTIVITIES[name].weight > 0);
  const total = pool.reduce((sum, name) => sum + ACTIVITIES[name].weight, 0);
  let roll = Math.random() * total;
  for (const name of pool) {
    roll -= ACTIVITIES[name].weight;
    if (roll <= 0) return name;
  }
  return pool[0] ?? null;
}
