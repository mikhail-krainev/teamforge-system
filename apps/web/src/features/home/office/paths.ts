/** Walkable grid over the office and A* routes on it, smoothed so people cut corners like people do. */
import { WORLD_D, WORLD_W, type Point } from './iso';
import { FURNITURE, PARTITIONS } from './world';

const CELLS_PER_TILE = 2;
const COLS = WORLD_W * CELLS_PER_TILE;
const ROWS = WORLD_D * CELLS_PER_TILE;
const FURNITURE_MARGIN = 0.15;
const WALL_REACH = 0.5;
const EDGE_MARGIN = 0.5;
const LINE_STEP = 0.1;

function cellCenter(col: number, row: number): Point {
  return { x: (col + 0.5) / CELLS_PER_TILE, y: (row + 0.5) / CELLS_PER_TILE };
}

function isInDoor(value: number, doors: [number, number][]): boolean {
  return doors.some(([from, to]) => value > from && value < to);
}

function isBlockedPoint({ x, y }: Point): boolean {
  if (x < EDGE_MARGIN || y < EDGE_MARGIN) return true;
  if (x > WORLD_W - EDGE_MARGIN || y > WORLD_D - EDGE_MARGIN) return true;
  const hitsWall = PARTITIONS.some((wall) => {
    const across = wall.axis === 'y' ? x : y;
    const along = wall.axis === 'y' ? y : x;
    if (Math.abs(across - wall.at) >= WALL_REACH) return false;
    if (along < wall.from || along > wall.to) return false;
    return !isInDoor(along, wall.doors);
  });
  if (hitsWall) return true;
  return FURNITURE.some(
    (f) =>
      f.isSolid &&
      x > f.x - FURNITURE_MARGIN &&
      x < f.x + f.w + FURNITURE_MARGIN &&
      y > f.y - FURNITURE_MARGIN &&
      y < f.y + f.d + FURNITURE_MARGIN,
  );
}

const BLOCKED: boolean[] = Array.from({ length: COLS * ROWS }, (_, i) =>
  isBlockedPoint(cellCenter(i % COLS, Math.floor(i / COLS))),
);

function cellOf({ x, y }: Point): [number, number] {
  return [
    Math.min(COLS - 1, Math.max(0, Math.floor(x * CELLS_PER_TILE))),
    Math.min(ROWS - 1, Math.max(0, Math.floor(y * CELLS_PER_TILE))),
  ];
}

function isFree(col: number, row: number): boolean {
  return col >= 0 && row >= 0 && col < COLS && row < ROWS && !BLOCKED[row * COLS + col];
}

/** Nearest walkable cell to a point, for targets that sit on a chair or sofa. */
function nearestFree(point: Point): [number, number] {
  const [col, row] = cellOf(point);
  if (isFree(col, row)) return [col, row];
  for (let r = 1; r < Math.max(COLS, ROWS); r += 1) {
    let best: [number, number] | null = null;
    let bestDist = Infinity;
    for (let dc = -r; dc <= r; dc += 1) {
      for (let dr = -r; dr <= r; dr += 1) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== r || !isFree(col + dc, row + dr)) continue;
        const c = cellCenter(col + dc, row + dr);
        const dist = (c.x - point.x) ** 2 + (c.y - point.y) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          best = [col + dc, row + dr];
        }
      }
    }
    if (best) return best;
  }
  return [col, row];
}

const NEIGHBOURS: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

function astar(start: [number, number], goal: [number, number]): [number, number][] {
  const key = (c: number, r: number) => r * COLS + c;
  const goalKey = key(goal[0], goal[1]);
  const cost = new Map<number, number>([[key(start[0], start[1]), 0]]);
  const from = new Map<number, number>();
  const open: { k: number; f: number }[] = [{ k: key(start[0], start[1]), f: 0 }];
  const h = (c: number, r: number) => Math.hypot(c - goal[0], r - goal[1]);
  while (open.length > 0) {
    open.sort((a, b) => a.f - b.f);
    const current = open.shift();
    if (!current) break;
    if (current.k === goalKey) break;
    const c = current.k % COLS;
    const r = Math.floor(current.k / COLS);
    for (const [dc, dr, step] of NEIGHBOURS) {
      const nc = c + dc;
      const nr = r + dr;
      if (!isFree(nc, nr)) continue;
      if (dc !== 0 && dr !== 0 && (!isFree(c + dc, r) || !isFree(c, r + dr))) continue;
      const nk = key(nc, nr);
      const next = (cost.get(current.k) ?? 0) + step;
      if (next >= (cost.get(nk) ?? Infinity)) continue;
      cost.set(nk, next);
      from.set(nk, current.k);
      open.push({ k: nk, f: next + h(nc, nr) });
    }
  }
  if (!cost.has(goalKey)) return [];
  const cells: [number, number][] = [];
  for (let k: number | undefined = goalKey; k !== undefined; k = from.get(k)) {
    cells.unshift([k % COLS, Math.floor(k / COLS)]);
  }
  return cells;
}

function hasLineOfSight(a: Point, b: Point): boolean {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / LINE_STEP);
  for (let i = 1; i < steps; i += 1) {
    const [c, r] = cellOf({ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps });
    if (!isFree(c, r)) return false;
  }
  return true;
}

/** Drops every waypoint that a straight walk can skip. */
function smooth(points: Point[]): Point[] {
  if (points.length < 3) return points;
  const [first, ...rest] = points;
  if (!first) return points;
  const out: Point[] = [first];
  let anchor = first;
  let previous = first;
  for (const point of rest) {
    if (!hasLineOfSight(anchor, point)) {
      out.push(previous);
      anchor = previous;
    }
    previous = point;
  }
  out.push(previous);
  return out;
}

/** Waypoints from one point to another, ending exactly on the target. Empty when there is no way. */
export function route(from: Point, to: Point): Point[] {
  const cells = astar(nearestFree(from), nearestFree(to));
  if (cells.length === 0) return [];
  const middle = cells.map(([c, r]) => cellCenter(c, r));
  return smooth([from, ...middle.slice(1, -1), to]);
}

export function isWalkable(point: Point): boolean {
  const [c, r] = cellOf(point);
  return isFree(c, r);
}
