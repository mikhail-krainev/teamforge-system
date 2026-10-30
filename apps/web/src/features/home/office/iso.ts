/** Isometric projection for the office scene. World units are floor tiles; z is in screen pixels. */
export const TILE_W = 48;
export const TILE_H = 24;
export const WORLD_W = 24;
export const WORLD_D = 14;
export const WALL_H = 74;
export const SLAB_H = 16;
export const VIEW_W = 1000;
export const VIEW_H = 590;

const ORIGIN_X = WORLD_D * (TILE_W / 2) + 44;
const ORIGIN_Y = WALL_H + 34;

export interface Point {
  x: number;
  y: number;
}

export function project(x: number, y: number, z = 0): Point {
  return {
    x: ORIGIN_X + (x - y) * (TILE_W / 2),
    y: ORIGIN_Y + (x + y) * (TILE_H / 2) - z,
  };
}

/** "x,y" for one projected corner, rounded so server and client markup match. */
export function corner(x: number, y: number, z = 0): string {
  const p = project(x, y, z);
  return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
}

export function polygon(points: [number, number, number?][]): string {
  return points.map(([x, y, z]) => corner(x, y, z ?? 0)).join(' ');
}

/** Maps tile coordinates on the floor to the screen, so floor patterns and text lie flat. */
export const FLOOR_MATRIX = `matrix(${TILE_W / 2} ${TILE_H / 2} ${-TILE_W / 2} ${TILE_H / 2} ${ORIGIN_X} ${ORIGIN_Y})`;

/** Length of one tile along a back wall, in pixels. */
export const WALL_TILE = Math.hypot(TILE_W / 2, TILE_H / 2);
const WALL_COS = TILE_W / 2 / WALL_TILE;
const WALL_SIN = TILE_H / 2 / WALL_TILE;

/** Back wall along y = 0: u runs along the wall in pixels from x = 0, v runs down from the wall top. */
export const NORTH_WALL_MATRIX = `matrix(${WALL_COS} ${WALL_SIN} 0 1 ${ORIGIN_X} ${ORIGIN_Y - WALL_H})`;

/** Back wall along x = 0, read left to right: u runs in pixels from the far corner (y = WORLD_D). */
export const WEST_WALL_MATRIX = `matrix(${WALL_COS} ${-WALL_SIN} 0 1 ${ORIGIN_X - WORLD_D * (TILE_W / 2)} ${ORIGIN_Y + WORLD_D * (TILE_H / 2) - WALL_H})`;

export interface BoxFaces {
  top: string;
  /** Face at x + w, lit side. */
  east: string;
  /** Face at y + d, shaded side. */
  south: string;
}

/** The three visible faces of a box standing on the floor (or at height z). */
export function boxFaces(x: number, y: number, w: number, d: number, h: number, z = 0): BoxFaces {
  const x1 = x + w;
  const y1 = y + d;
  const zt = z + h;
  return {
    top: polygon([
      [x, y, zt],
      [x1, y, zt],
      [x1, y1, zt],
      [x, y1, zt],
    ]),
    east: polygon([
      [x1, y, z],
      [x1, y1, z],
      [x1, y1, zt],
      [x1, y, zt],
    ]),
    south: polygon([
      [x, y1, z],
      [x1, y1, z],
      [x1, y1, zt],
      [x, y1, zt],
    ]),
  };
}

/** Draw order: things further from the viewer (smaller x + y) come first. */
export function depthOf(x: number, y: number): number {
  return x + y;
}

/** Screen-space facing for a move or look along (dx, dy) in the world. */
export function facingOf(dx: number, dy: number): { isFlipped: boolean; isFront: boolean } {
  return { isFlipped: dx - dy < 0, isFront: dx + dy > 0 };
}
