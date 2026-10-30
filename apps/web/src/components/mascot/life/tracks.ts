import type { Point, Track } from './types';

const CROUCH_MS = 150;
const LAND_MS = 200;
const WALK_SPEED_PX_PER_MS = 0.11;
const WALK_STEP_MS = 150;
const FLOAT_MS = 1900;
/** Gravity for falls, px per ms squared. */
const GRAVITY = 0.0032;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const faceOf = (from: Point, to: Point): 1 | -1 => (to.x >= from.x ? 1 : -1);

const still = { sx: 1, sy: 1, rotate: 0, props: [] } as const;

/** Squash on touchdown that springs back to 1. */
function landing(t: number) {
  const k = Math.sin(clamp01(t) * Math.PI);
  return { sx: 1 + 0.18 * k, sy: 1 - 0.2 * k };
}

/** Crouch, arc through the air, squash on landing. Scale eases from s0 to s1 in the air. */
export function jumpTrack(from: Point, to: Point, s0 = 1, s1 = 1): Track {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const air = Math.min(1100, Math.max(460, 360 + dist * 0.55));
  const peak = Math.min(from.y, to.y) - Math.max(56, Math.abs(to.x - from.x) * 0.22);
  const control = 2 * peak - (from.y + to.y) / 2;
  const facing = faceOf(from, to);
  return {
    duration: CROUCH_MS + air + LAND_MS,
    sample: (ms) => {
      if (ms < CROUCH_MS) {
        const k = Math.sin((ms / CROUCH_MS) * (Math.PI / 2));
        return {
          ...from,
          ...still,
          scale: s0,
          sx: 1 + 0.12 * k,
          sy: 1 - 0.18 * k,
          facing,
          frame: 'crouch',
        };
      }
      const t = clamp01((ms - CROUCH_MS) / air);
      if (t < 1) {
        const u = easeInOut(t);
        const y = (1 - t) ** 2 * from.y + 2 * t * (1 - t) * control + t ** 2 * to.y;
        const rising = t < 0.5;
        return {
          x: lerp(from.x, to.x, u),
          y,
          ...still,
          scale: lerp(s0, s1, u),
          sx: rising ? 0.9 : 1,
          sy: rising ? 1.12 : 1.04,
          rotate: facing * 10 * Math.sin(t * Math.PI) * (rising ? 1 : -0.6),
          facing,
          frame: rising ? 'jump' : 'fall',
        };
      }
      const land = (ms - CROUCH_MS - air) / LAND_MS;
      return { ...to, ...still, scale: s1, ...landing(land), facing, frame: 'land' };
    },
  };
}

/** Walk along a ledge with a two-step cycle and a small bob. */
export function walkTrack(from: Point, toX: number, scale = 1): Track {
  const duration = Math.max(1, Math.abs(toX - from.x) / WALK_SPEED_PX_PER_MS);
  const facing = toX >= from.x ? 1 : -1;
  return {
    duration,
    sample: (ms) => {
      const step = Math.floor(ms / WALK_STEP_MS) % 2;
      return {
        x: lerp(from.x, toX, clamp01(ms / duration)),
        y: from.y - (step ? 2 : 0),
        ...still,
        scale,
        facing,
        frame: step ? 'walk2' : 'walk1',
      };
    },
  };
}

/** Long drop: drifts down under a parachute with a sway that settles before touchdown. */
export function parachuteTrack(from: Point, to: Point, s0 = 1, s1 = 1): Track {
  return floatTrack(from, to, 'parachute', s0, s1);
}

/** Long climb: rises on a balloon, lets it go at the top. */
export function balloonTrack(from: Point, to: Point, s0 = 1, s1 = 1): Track {
  return floatTrack(from, to, 'balloon', s0, s1);
}

function floatTrack(
  from: Point,
  to: Point,
  prop: 'parachute' | 'balloon',
  s0: number,
  s1: number,
): Track {
  return {
    duration: FLOAT_MS + LAND_MS,
    sample: (ms) => {
      const t = clamp01(ms / FLOAT_MS);
      if (t < 1) {
        const u = easeOut(t);
        const sway = Math.sin(t * Math.PI * 3) * (1 - t);
        return {
          x: lerp(from.x, to.x, u) + sway * 28,
          y: lerp(from.y, to.y, u),
          ...still,
          scale: lerp(s0, s1, u),
          rotate: sway * 9,
          facing: 1,
          frame: Math.floor(ms / 320) % 2 ? 'hang2' : 'hang1',
          props: [{ name: prop }],
        };
      }
      const land = (ms - FLOAT_MS) / LAND_MS;
      const released = prop === 'balloon' ? [{ name: prop, className: 'life-prop-away' }] : [];
      return {
        ...to,
        ...still,
        scale: s1,
        ...landing(land),
        facing: 1,
        frame: 'land',
        props: released,
      };
    },
  };
}

/** Drop under gravity (letting go of the cursor), then land. */
export function fallTrack(from: Point, to: Point): Track {
  const height = Math.max(0, to.y - from.y);
  const air = Math.max(220, Math.sqrt((2 * height) / GRAVITY));
  const facing = faceOf(from, to);
  return {
    duration: air + LAND_MS,
    sample: (ms) => {
      if (ms < air) {
        const t = ms / air;
        return {
          x: lerp(from.x, to.x, easeOut(t)),
          y: Math.min(to.y, from.y + 0.5 * GRAVITY * ms * ms),
          ...still,
          scale: 1,
          rotate: facing * 14 * (1 - t),
          facing,
          frame: 'fall',
        };
      }
      return { ...to, ...still, scale: 1, ...landing((ms - air) / LAND_MS), facing, frame: 'land' };
    },
  };
}
