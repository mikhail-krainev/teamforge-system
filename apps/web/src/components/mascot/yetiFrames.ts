import type { Gaze, Reaction } from './reactions';
import { POSES, type YetiPose } from './Yeti';

type EyeShape = 'open' | 'blink' | 'wide' | 'dizzy';
type EyeSpec = { pattern: readonly string[]; y: number; leftX: number; rightX: number };

// Eyes use their own palette char 'E' so they can be swapped or shifted; the face is 'B'.
const EYES: Record<EyeShape, EyeSpec> = {
  open: { pattern: ['EE', 'EE'], y: 7, leftX: 6, rightX: 12 },
  blink: { pattern: ['EE'], y: 8, leftX: 6, rightX: 12 },
  wide: { pattern: ['EE', 'EE', 'EE'], y: 6, leftX: 6, rightX: 12 },
  dizzy: { pattern: ['EEE', 'E.E', '.EE'], y: 6, leftX: 5, rightX: 12 },
};

const FACE_X = 5;
const FACE_Y = 6;
const FACE_FILL: readonly string[] = Array.from({ length: 4 }, () => 'B'.repeat(10));
const CHEEK_ROW = 9;

/** Returns a copy of the grid with `pattern` written at x,y; '.' keeps the cell below. */
function stamp(grid: readonly string[], x: number, y: number, pattern: readonly string[]) {
  return grid.map((row, rowIndex) => {
    const line = pattern[rowIndex - y];
    if (line === undefined) return row;
    return [...row]
      .map((cell, col) => {
        const next = line[col - x];
        return next && next !== '.' ? next : cell;
      })
      .join('');
  });
}

function withEyes(shape: EyeShape, gaze: Gaze = { x: 0, y: 0 }): readonly string[] {
  const spec = EYES[shape];
  const shift = shape === 'open' ? gaze : { x: 0, y: 0 };
  const y = spec.y + shift.y;
  const bare = stamp(POSES.idle, FACE_X, FACE_Y, FACE_FILL);
  const left = stamp(bare, spec.leftX + shift.x, y, spec.pattern);
  return stamp(left, spec.rightX + shift.x, y, spec.pattern);
}

function withCheeks(grid: readonly string[]): readonly string[] {
  return stamp(stamp(grid, 5, CHEEK_ROW, ['CC']), 13, CHEEK_ROW, ['CC']);
}

/** The sprite grid for the current pose, reaction, gaze and blink. */
export function buildFrame(
  pose: YetiPose,
  reaction: Reaction,
  gaze: Gaze,
  isBlinking: boolean,
): readonly string[] {
  switch (reaction) {
    case 'celebrate':
      return POSES.celebrate;
    case 'wave':
    case 'perk':
      return POSES.wave;
    case 'blush':
      return withCheeks(withEyes('blink'));
    case 'surprised':
      return withEyes('wide');
    case 'dizzy':
      return withEyes('dizzy');
    case 'sleep':
      return withEyes('blink');
    default:
      return pose === 'idle' ? withEyes(isBlinking ? 'blink' : 'open', gaze) : POSES[pose];
  }
}
