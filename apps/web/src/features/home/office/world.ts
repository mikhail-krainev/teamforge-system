/** Office layout in tile units: rooms, partitions with doors, furniture footprints and the places people go. */
import { WORLD_D, WORLD_W, type Point } from './iso';

export type RoomId = 'queue' | 'team' | 'trial' | 'kitchen' | 'meeting' | 'lounge';
export type Look = 'n' | 's' | 'e' | 'w';

export interface Room {
  id: RoomId;
  x: number;
  y: number;
  w: number;
  d: number;
  floor: 'carpet' | 'planks' | 'mint' | 'tiles' | 'felt' | 'rug';
}

export const ROOMS: Room[] = [
  { id: 'queue', x: 0, y: 0, w: 7, d: 8, floor: 'carpet' },
  { id: 'team', x: 7, y: 0, w: 9, d: 8, floor: 'planks' },
  { id: 'trial', x: 16, y: 0, w: 8, d: 8, floor: 'mint' },
  { id: 'kitchen', x: 0, y: 8, w: 7, d: 6, floor: 'tiles' },
  { id: 'meeting', x: 7, y: 8, w: 8, d: 6, floor: 'felt' },
  { id: 'lounge', x: 15, y: 8, w: 9, d: 6, floor: 'rug' },
];

/** A low partition along one axis; doors are open spans on it. */
export interface Partition {
  axis: 'x' | 'y';
  /** Fixed coordinate: x for axis 'y' walls, y for axis 'x' walls. */
  at: number;
  from: number;
  to: number;
  doors: [number, number][];
}

export const PARTITIONS: Partition[] = [
  { axis: 'y', at: 7, from: 0, to: 8, doors: [[4, 5.2]] },
  { axis: 'y', at: 16, from: 0, to: 8, doors: [[4, 5.2]] },
  { axis: 'y', at: 7, from: 8, to: WORLD_D, doors: [[10.5, 11.7]] },
  { axis: 'y', at: 15, from: 8, to: WORLD_D, doors: [[10, 11.2]] },
  {
    axis: 'x',
    at: 8,
    from: 0,
    to: WORLD_W,
    doors: [
      [3, 4.2],
      [13.4, 14.6],
      [19.6, 20.8],
    ],
  },
];

export const PARTITION_H = 20;
export const PARTITION_T = 0.22;

/** Doorway on the back wall where newcomers appear, and the exit off the front edge of the lounge. */
export const ENTRY: Point = { x: 0.7, y: 4.6 };
export const EXIT_INSIDE: Point = { x: 22.6, y: 13.2 };
export const EXIT_OUTSIDE: Point = { x: 22.6, y: 14.9 };

export type FurnitureKind =
  | 'desk'
  | 'chair'
  | 'bench'
  | 'post'
  | 'cooler'
  | 'plant'
  | 'counter'
  | 'fridge'
  | 'table'
  | 'stool'
  | 'meetingTable'
  | 'screen'
  | 'sofa'
  | 'armchair'
  | 'pingpong'
  | 'shelf'
  | 'trialTable'
  | 'beanbag'
  | 'lamp';

export interface Furniture {
  id: string;
  kind: FurnitureKind;
  x: number;
  y: number;
  w: number;
  d: number;
  /** People walk around it; chairs and posts stay walkable. */
  isSolid: boolean;
  /** Which way a desk, chair or sofa faces. */
  look?: Look;
}

function item(
  id: string,
  kind: FurnitureKind,
  x: number,
  y: number,
  w: number,
  d: number,
  look?: Look,
  isSolid = true,
): Furniture {
  return { id, kind, x, y, w, d, isSolid, look };
}

export interface Seat {
  id: string;
  at: Point;
  look: Look;
}

const DESK_XS = [7.9, 10.7, 13.5] as const;
const DESK_W = 1.8;

/** Six team desks: the top row faces the back wall, the bottom row faces the viewer. */
export const SEATS: Seat[] = DESK_XS.flatMap((x, i) => [
  { id: `top-${i}`, at: { x: x + DESK_W / 2, y: 2.6 }, look: 'n' as Look },
  { id: `bottom-${i}`, at: { x: x + DESK_W / 2, y: 5.4 }, look: 's' as Look },
]);

const MEETING_CHAIRS: [number, number, Look][] = [
  [10, 9.8, 's'],
  [12.3, 9.8, 's'],
  [10.6, 12.4, 'n'],
  [12.4, 12.4, 'n'],
];

export const FURNITURE: Furniture[] = [
  // queue
  item('bench', 'bench', 1.2, 0.5, 3, 0.7, 's'),
  item('cooler', 'cooler', 5.6, 0.5, 0.7, 0.7),
  item('plant-q', 'plant', 0.5, 7, 0.7, 0.7),
  ...[1.4, 3.2, 5].flatMap((x) => [
    item(`post-a-${x}`, 'post', x, 3.4, 0.25, 0.25, undefined, false),
    item(`post-b-${x}`, 'post', x, 5.6, 0.25, 0.25, undefined, false),
  ]),
  // team
  ...DESK_XS.flatMap((x, i) => [
    item(`desk-top-${i}`, 'desk', x, 1.2, DESK_W, 0.9, 'n'),
    item(`desk-bottom-${i}`, 'desk', x, 5.9, DESK_W, 0.9, 's'),
  ]),
  ...SEATS.map((seat) =>
    item(
      `chair-${seat.id}`,
      'chair',
      seat.at.x - 0.3,
      seat.at.y - 0.3,
      0.6,
      0.6,
      seat.look,
      false,
    ),
  ),
  item('plant-t', 'plant', 15.1, 0.5, 0.6, 0.6),
  item('shelf-t', 'shelf', 7.5, 7.1, 2.2, 0.6),
  // trial
  item('trial-table', 'trialTable', 18, 3.4, 3.4, 1.6),
  item('sofa-t', 'sofa', 22.6, 2.8, 0.9, 2.6, 'w'),
  item('lamp-t', 'lamp', 16.6, 6.8, 0.5, 0.5),
  // kitchen
  item('counter', 'counter', 0.4, 8.6, 0.9, 3.6),
  item('fridge', 'fridge', 0.4, 12.4, 0.9, 1),
  item('kitchen-table', 'table', 3.4, 10.6, 1.4, 1.4),
  item('stool-a', 'stool', 5.4, 11.1, 0.5, 0.5, undefined, false),
  // meeting
  item('meeting-table', 'meetingTable', 9.2, 10.4, 4, 1.4),
  item('screen', 'screen', 10.2, 8.35, 2, 0.35),
  item('plant-m', 'plant', 7.5, 13.1, 0.6, 0.6),
  ...MEETING_CHAIRS.map(([x, y, look]) =>
    item(`chair-m-${x}-${y}`, 'chair', x - 0.3, y - 0.3, 0.6, 0.6, look, false),
  ),
  // lounge
  item('sofa-l', 'sofa', 15.6, 8.5, 2.8, 0.9, 's'),
  item('armchair', 'armchair', 15.6, 12.0, 0.9, 0.9, 'e'),
  item('pingpong', 'pingpong', 19.1, 10.2, 3, 1.4),
  item('beanbag', 'beanbag', 22.7, 8.6, 0.9, 0.9),
  item('plant-l', 'plant', 18.7, 13.1, 0.6, 0.6),
];

/** Queue spots from the front (by the team door) to the back. */
export const QUEUE_SLOTS: Point[] = [6.1, 5.0, 3.9, 2.8, 1.7].map((x) => ({ x, y: 4.6 }));

export interface Spot {
  id: string;
  at: Point;
  look: Look;
  isSeated?: boolean;
  /** Spots in the same group are close enough for a conversation. */
  group: string;
}

export const SPOTS: Spot[] = [
  { id: 'coffee', at: { x: 1.8, y: 9.4 }, look: 'w', group: 'kitchen' },
  { id: 'fridge', at: { x: 1.8, y: 12.6 }, look: 'w', group: 'kitchen' },
  { id: 'kitchen-a', at: { x: 3, y: 9.6 }, look: 'e', group: 'kitchen' },
  { id: 'kitchen-b', at: { x: 4.1, y: 9.6 }, look: 'w', group: 'kitchen' },
  { id: 'meet-1', at: { x: 10, y: 9.8 }, look: 's', isSeated: true, group: 'meeting' },
  { id: 'meet-2', at: { x: 12.3, y: 9.8 }, look: 's', isSeated: true, group: 'meeting' },
  { id: 'meet-3', at: { x: 10.6, y: 12.4 }, look: 'n', isSeated: true, group: 'meeting' },
  { id: 'meet-4', at: { x: 12.4, y: 12.4 }, look: 'n', isSeated: true, group: 'meeting' },
  { id: 'sofa-1', at: { x: 16.4, y: 9.0 }, look: 's', isSeated: true, group: 'sofa' },
  { id: 'sofa-2', at: { x: 17.6, y: 9.0 }, look: 's', isSeated: true, group: 'sofa' },
  { id: 'arm', at: { x: 16.05, y: 12.45 }, look: 'e', isSeated: true, group: 'sofa' },
  { id: 'lounge-a', at: { x: 19.4, y: 12.7 }, look: 'e', group: 'lounge' },
  { id: 'lounge-b', at: { x: 20.5, y: 12.7 }, look: 'w', group: 'lounge' },
  { id: 'board', at: { x: 19.2, y: 2.2 }, look: 'n', group: 'trial' },
  { id: 'board-b', at: { x: 20.6, y: 2.2 }, look: 'n', group: 'trial' },
  { id: 'trial-sofa', at: { x: 22.95, y: 4.1 }, look: 'w', isSeated: true, group: 'trial' },
  { id: 'window', at: { x: 11.6, y: 3.6 }, look: 'n', group: 'team' },
];

/** Ping-pong players stand at both ends of the table. */
export const PINGPONG_ENDS: [Point, Point] = [
  { x: 18.55, y: 10.9 },
  { x: 22.65, y: 10.9 },
];

export const LOOK_VECTORS: Record<Look, Point> = {
  n: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  e: { x: 1, y: 0 },
  w: { x: -1, y: 0 },
};
