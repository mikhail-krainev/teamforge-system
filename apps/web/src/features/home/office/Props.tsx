/** Furniture and low partitions as depth-sorted sprites. */
import type { ReactNode } from 'react';
import { Box, PAINT, Seg } from './Box';
import { depthOf, polygon, project, WORLD_D, WORLD_W } from './iso';
import {
  FURNITURE,
  PARTITION_H,
  PARTITION_T,
  PARTITIONS,
  type Furniture,
  type FurnitureKind,
} from './world';

export interface Sprite {
  key: string;
  depth: number;
  node: ReactNode;
}

const DESK_Z = 26;
const SEAT_Z = 13;
const LEG = 0.09;

function Legs({ f, h, inset = 0.06, tone = PAINT.steel }: { f: Furniture; h: number; inset?: number; tone?: string }) {
  const xs = [f.x + inset, f.x + f.w - inset - LEG];
  const ys = [f.y + inset, f.y + f.d - inset - LEG];
  return (
    <>
      {ys.flatMap((y) =>
        xs.map((x) => <Box key={`${x}-${y}`} x={x} y={y} w={LEG} d={LEG} h={h} tone={tone} />),
      )}
    </>
  );
}

/** Code on a monitor that faces the viewer's side (south). */
function ScreenCode({ x, y, w, z }: { x: number; y: number; w: number; z: number }) {
  const lines = [0.55, 0.3, 0.7, 0.4];
  return (
    <g className="office-code">
      <polygon
        className="office-glow"
        points={polygon([
          [x + 0.06, y, z + 3],
          [x + w - 0.06, y, z + 3],
          [x + w - 0.06, y, z + 17],
          [x + 0.06, y, z + 17],
        ])}
      />
      {lines.map((len, i) => (
        <Seg
          key={i}
          className={`office-code-line office-code-${i}`}
          a={[x + 0.14 + (i % 2) * 0.08, y, z + 14 - i * 3]}
          b={[x + 0.14 + (i % 2) * 0.08 + (w - 0.3) * len, y, z + 14 - i * 3]}
        />
      ))}
    </g>
  );
}

function Desk({ f }: { f: Furniture }) {
  const facesViewer = f.look === 'n';
  const monitorY = facesViewer ? f.y + 0.12 : f.y + f.d - 0.22;
  const cx = f.x + f.w / 2;
  const keyboardY = facesViewer ? f.y + f.d - 0.36 : f.y + 0.14;
  return (
    <>
      <Legs f={f} h={DESK_Z} />
      <Box x={f.x} y={f.y} w={f.w} d={f.d} h={4} z={DESK_Z} tone={PAINT.wood} />
      <Box x={cx - 0.06} y={monitorY + 0.02} w={0.12} d={0.08} h={6} z={DESK_Z + 4} tone={PAINT.steel} />
      <Box x={cx - 0.48} y={monitorY} w={0.96} d={0.1} h={20} z={DESK_Z + 9} tone={PAINT.ink} />
      {facesViewer && <ScreenCode x={cx - 0.48} y={monitorY + 0.1} w={0.96} z={DESK_Z + 9} />}
      <Box x={cx - 0.32} y={keyboardY} w={0.64} d={0.2} h={1.5} z={DESK_Z + 4} tone={PAINT.grey} />
      <Box x={f.x + 0.14} y={f.y + 0.3} w={0.22} d={0.22} h={7} z={DESK_Z + 4} tone={PAINT.cream} />
      <Box x={f.x + f.w - 0.42} y={f.y + 0.24} w={0.3} d={0.4} h={1} z={DESK_Z + 4} tone={PAINT.yellow} />
    </>
  );
}

/** Chair seat; the back rest is a separate sprite so it can cover a seated person's lower back. */
function ChairSeat({ f }: { f: Furniture }) {
  const cx = f.x + f.w / 2;
  const cy = f.y + f.d / 2;
  return (
    <>
      <Box x={cx - 0.05} y={cy - 0.05} w={0.1} d={0.1} h={SEAT_Z - 2} tone={PAINT.steel} />
      <Box x={f.x + 0.04} y={f.y + 0.04} w={f.w - 0.08} d={f.d - 0.08} h={3} z={SEAT_Z - 2} tone={PAINT.blue} />
    </>
  );
}

function chairBack(f: Furniture): { x: number; y: number; w: number; d: number } {
  const t = 0.1;
  if (f.look === 'n') return { x: f.x + 0.04, y: f.y + f.d - t, w: f.w - 0.08, d: t };
  if (f.look === 's') return { x: f.x + 0.04, y: f.y, w: f.w - 0.08, d: t };
  if (f.look === 'e') return { x: f.x, y: f.y + 0.04, w: t, d: f.d - 0.08 };
  return { x: f.x + f.w - t, y: f.y + 0.04, w: t, d: f.d - 0.08 };
}

function Plant({ f }: { f: Furniture }) {
  const base = project(f.x + f.w / 2, f.y + f.d / 2, 18);
  const leaves = [
    [-9, -10, -30],
    [8, -12, 28],
    [-3, -20, -8],
    [5, -4, 50],
    [-10, -2, -60],
  ];
  return (
    <>
      <Box x={f.x + 0.08} y={f.y + 0.08} w={f.w - 0.16} d={f.d - 0.16} h={18} tone={PAINT.clay} />
      <g transform={`translate(${base.x.toFixed(1)} ${base.y.toFixed(1)})`} className="office-plant">
        {leaves.map(([x, y, r], i) => (
          <ellipse
            key={i}
            cx={x}
            cy={y}
            rx="5.5"
            ry="11"
            transform={`rotate(${r} ${x} ${y})`}
            fill={i % 2 ? PAINT.leaf : PAINT.leafLight}
          />
        ))}
      </g>
    </>
  );
}

function Sofa({ f, tone }: { f: Furniture; tone: string }) {
  const back = chairBack(f);
  const backT = 0.28;
  const backBox =
    f.look === 's'
      ? { ...back, d: backT }
      : f.look === 'w'
        ? { ...back, x: f.x + f.w - backT, w: backT }
        : f.look === 'e'
          ? { ...back, w: backT }
          : { ...back, y: f.y + f.d - backT, d: backT };
  return (
    <>
      <Box x={f.x} y={f.y} w={f.w} d={f.d} h={12} tone={tone} />
      <Box {...backBox} h={14} z={12} tone={tone} />
      <Box x={f.x + 0.12} y={f.y + 0.12} w={f.w - 0.24} d={f.d - 0.24} h={3} z={12} tone={PAINT.cream} className="iso-cushion" />
    </>
  );
}

function Pingpong({ f }: { f: Furniture }) {
  const mid = f.x + f.w / 2;
  const z = 22;
  return (
    <>
      <Legs f={f} h={z} inset={0.3} />
      <Box x={f.x} y={f.y} w={f.w} d={f.d} h={3} z={z} tone={PAINT.teal} />
      <Seg className="office-chalk" a={[f.x + 0.08, f.y + f.d / 2, z + 3]} b={[f.x + f.w - 0.08, f.y + f.d / 2, z + 3]} />
      <Box x={mid - 0.03} y={f.y - 0.06} w={0.06} d={f.d + 0.12} h={6} z={z + 3} tone={PAINT.cream} className="iso-net" />
    </>
  );
}

function Shelf({ f }: { f: Furniture }) {
  const books = [PAINT.pink, PAINT.yellow, PAINT.blue, PAINT.teal, PAINT.orange, PAINT.cream, PAINT.red];
  return (
    <>
      <Box x={f.x} y={f.y} w={f.w} d={f.d} h={30} tone={PAINT.woodDark} />
      {books.map((tone, i) => (
        <Box
          key={i}
          x={f.x + 0.12 + i * 0.28}
          y={f.y + 0.12}
          w={0.2}
          d={f.d - 0.24}
          h={9 + ((i * 5) % 7)}
          z={30}
          tone={tone}
        />
      ))}
    </>
  );
}

function TrialTable({ f }: { f: Furniture }) {
  const z = 24;
  const notes = [PAINT.pink, PAINT.yellow, PAINT.blue, PAINT.orange];
  return (
    <>
      <Legs f={f} h={z} inset={0.12} />
      <Box x={f.x} y={f.y} w={f.w} d={f.d} h={4} z={z} tone={PAINT.cream} />
      <Box x={f.x + 1.3} y={f.y + 0.4} w={0.9} d={0.6} h={1.5} z={z + 4} tone={PAINT.steel} />
      <Box x={f.x + 1.3} y={f.y + 0.36} w={0.9} d={0.06} h={13} z={z + 4} tone={PAINT.ink} />
      {notes.map((tone, i) => (
        <Box key={i} x={f.x + 0.2 + i * 0.26} y={f.y + 0.9 + (i % 2) * 0.2} w={0.22} d={0.22} h={0.6} z={z + 4} tone={tone} />
      ))}
      <Box x={f.x + f.w - 0.5} y={f.y + 0.5} w={0.2} d={0.2} h={7} z={z + 4} tone={PAINT.pink} />
    </>
  );
}

function Counter({ f }: { f: Furniture }) {
  return (
    <>
      <Box x={f.x} y={f.y} w={f.w} d={f.d} h={28} tone={PAINT.cream} />
      <Box x={f.x - 0.02} y={f.y - 0.02} w={f.w + 0.04} d={f.d + 0.04} h={3} z={28} tone={PAINT.teal} />
      <Box x={f.x + 0.15} y={f.y + 0.4} w={0.6} d={0.55} h={20} z={31} tone={PAINT.ink} />
      <Box x={f.x + 0.25} y={f.y + 0.95} w={0.12} d={0.1} h={5} z={36} tone={PAINT.red} />
      <Box x={f.x + 0.2} y={f.y + 1.5} w={0.5} d={0.9} h={1} z={31} tone={PAINT.steel} />
      {[2.8, 3.05].map((y) => (
        <Box key={y} x={f.x + 0.4} y={f.y + y} w={0.18} d={0.18} h={6} z={31} tone={y > 3 ? PAINT.yellow : PAINT.pink} />
      ))}
      {[0.6, 1.8, 3].map((y) => (
        <Seg key={y} className="office-handle" a={[f.x + f.w, f.y + y, 20]} b={[f.x + f.w, f.y + y + 0.4, 20]} />
      ))}
    </>
  );
}

function Screen({ f }: { f: Furniture }) {
  const bars = [6, 11, 8, 15, 12];
  return (
    <>
      <Box x={f.x + f.w / 2 - 0.08} y={f.y + 0.1} w={0.16} d={0.12} h={18} tone={PAINT.steel} />
      <Box x={f.x} y={f.y} w={f.w} d={0.12} h={34} z={16} tone={PAINT.ink} />
      {bars.map((h, i) => (
        <polygon
          key={i}
          className={`office-bar office-bar-${i}`}
          points={polygon([
            [f.x + 0.3 + i * 0.3, f.y + 0.12, 21],
            [f.x + 0.5 + i * 0.3, f.y + 0.12, 21],
            [f.x + 0.5 + i * 0.3, f.y + 0.12, 21 + h],
            [f.x + 0.3 + i * 0.3, f.y + 0.12, 21 + h],
          ])}
        />
      ))}
    </>
  );
}

function Beanbag({ f }: { f: Furniture }) {
  const c = project(f.x + f.w / 2, f.y + f.d / 2, 0);
  return (
    <g transform={`translate(${c.x.toFixed(1)} ${c.y.toFixed(1)})`} className="office-beanbag">
      <path d="M-20 0c-2-12 6-22 20-22s23 9 20 22c-4 7-36 7-40 0z" />
      <path className="office-crease" d="M-8-14c4 3 10 3 14-1" />
    </g>
  );
}

function Lamp({ f }: { f: Furniture }) {
  const cx = f.x + f.w / 2 - 0.05;
  const cy = f.y + f.d / 2 - 0.05;
  return (
    <>
      <Box x={cx - 0.15} y={cy - 0.15} w={0.4} d={0.4} h={2} tone={PAINT.ink} />
      <Box x={cx} y={cy} w={0.1} d={0.1} h={52} tone={PAINT.ink} />
      <Box x={cx - 0.22} y={cy - 0.22} w={0.54} d={0.54} h={12} z={50} tone={PAINT.yellow} />
    </>
  );
}

function Cooler({ f }: { f: Furniture }) {
  return (
    <>
      <Box x={f.x} y={f.y} w={f.w} d={f.d} h={30} tone={PAINT.cream} />
      <Box x={f.x + 0.12} y={f.y + 0.12} w={f.w - 0.24} d={f.d - 0.24} h={18} z={30} tone={PAINT.blue} className="iso-glass" />
      <Box x={f.x + f.w - 0.05} y={f.y + 0.28} w={0.08} d={0.14} h={3} z={18} tone={PAINT.red} />
    </>
  );
}

function Post({ f }: { f: Furniture }) {
  const top = project(f.x + f.w / 2, f.y + f.d / 2, 28);
  return (
    <>
      <Box x={f.x} y={f.y} w={f.w} d={f.d} h={2} tone={PAINT.ink} />
      <Box x={f.x + 0.08} y={f.y + 0.08} w={0.09} d={0.09} h={27} tone={PAINT.yellow} />
      <circle cx={top.x.toFixed(1)} cy={top.y.toFixed(1)} r="3" className="office-knob" />
    </>
  );
}

function Bench({ f }: { f: Furniture }) {
  return (
    <>
      <Legs f={f} h={11} />
      <Box x={f.x} y={f.y} w={f.w} d={f.d} h={4} z={11} tone={PAINT.woodDark} />
    </>
  );
}

function Fridge({ f }: { f: Furniture }) {
  return (
    <Box x={f.x} y={f.y} w={f.w} d={f.d} h={64} tone={PAINT.mint}>
      <Seg className="office-handle" a={[f.x + f.w, f.y + 0.2, 52]} b={[f.x + f.w, f.y + 0.2, 36]} />
      <Seg className="office-seam" a={[f.x + f.w, f.y, 30]} b={[f.x + f.w, f.y + f.d, 30]} />
    </Box>
  );
}

function KitchenTable({ f }: { f: Furniture }) {
  return (
    <>
      <Box x={f.x + f.w / 2 - 0.08} y={f.y + f.d / 2 - 0.08} w={0.16} d={0.16} h={22} tone={PAINT.steel} />
      <Box x={f.x} y={f.y} w={f.w} d={f.d} h={3} z={22} tone={PAINT.yellow} />
      <Box x={f.x + 0.4} y={f.y + 0.5} w={0.2} d={0.2} h={6} z={25} tone={PAINT.cream} />
    </>
  );
}

function MeetingTable({ f }: { f: Furniture }) {
  return (
    <>
      <Legs f={f} h={24} inset={0.2} />
      <Box x={f.x} y={f.y} w={f.w} d={f.d} h={4} z={24} tone={PAINT.woodDark} />
      <Box x={f.x + 0.6} y={f.y + 0.3} w={0.7} d={0.5} h={1} z={28} tone={PAINT.cream} />
      <Box x={f.x + 2.4} y={f.y + 0.5} w={0.8} d={0.5} h={1.5} z={28} tone={PAINT.steel} />
      <Box x={f.x + 1.7} y={f.y + 0.6} w={0.2} d={0.2} h={6} z={28} tone={PAINT.pink} />
    </>
  );
}

const RENDERERS: Record<FurnitureKind, (props: { f: Furniture }) => ReactNode> = {
  desk: Desk,
  chair: ChairSeat,
  bench: Bench,
  post: Post,
  cooler: Cooler,
  plant: Plant,
  counter: Counter,
  fridge: Fridge,
  table: KitchenTable,
  stool: ({ f }) => <Box x={f.x} y={f.y} w={f.w} d={f.d} h={16} tone={PAINT.orange} />,
  meetingTable: MeetingTable,
  screen: Screen,
  sofa: ({ f }) => <Sofa f={f} tone={f.id === 'sofa-l' ? PAINT.orange : PAINT.blue} />,
  armchair: ({ f }) => <Sofa f={f} tone={PAINT.pink} />,
  pingpong: Pingpong,
  shelf: Shelf,
  trialTable: TrialTable,
  beanbag: Beanbag,
  lamp: Lamp,
};

function FurnitureNode({ f }: { f: Furniture }) {
  const Render = RENDERERS[f.kind];
  return <Render f={f} />;
}

function centreDepth(f: { x: number; y: number; w: number; d: number }): number {
  return depthOf(f.x + f.w / 2, f.y + f.d / 2);
}

function furnitureSprites(): Sprite[] {
  return FURNITURE.flatMap((f) => {
    if (f.kind !== 'chair') {
      return [{ key: f.id, depth: centreDepth(f), node: <FurnitureNode key={f.id} f={f} /> }];
    }
    const back = chairBack(f);
    // A back rest towards the viewer is drawn after the person sitting on the chair.
    const isFront = f.look === 'n' || f.look === 'w';
    return [
      { key: f.id, depth: centreDepth(f) - 0.02, node: <FurnitureNode key={f.id} f={f} /> },
      {
        key: `${f.id}-back`,
        depth: centreDepth(f) + (isFront ? 0.25 : -0.25),
        node: <Box key={`${f.id}-back`} {...back} h={12} z={SEAT_Z + 1} tone={PAINT.ultramarine} />,
      },
    ];
  });
}

const WALL_SEGMENT = 1;

/** Partitions cut into tile-long pieces so people sort correctly against each piece. */
function partitionSprites(): Sprite[] {
  const sprites: Sprite[] = [];
  PARTITIONS.forEach((wall, wi) => {
    const starts = [wall.from, ...wall.doors.map(([, to]) => to)];
    const ends = [...wall.doors.map(([from]) => from), wall.to];
    starts.forEach((start, i) => {
      const end = ends[i] ?? wall.to;
      for (let a = start; a < end - 0.001; a += WALL_SEGMENT) {
        const b = Math.min(a + WALL_SEGMENT, end);
        const box =
          wall.axis === 'y'
            ? { x: wall.at - PARTITION_T / 2, y: a, w: PARTITION_T, d: b - a }
            : { x: a, y: wall.at - PARTITION_T / 2, w: b - a, d: PARTITION_T };
        const key = `wall-${wi}-${a}`;
        sprites.push({
          key,
          depth: centreDepth(box),
          node: <Box key={key} {...box} h={PARTITION_H} tone={PAINT.cream} className="iso-wall" />,
        });
      }
    });
  });
  return sprites;
}

const LIP_H = 9;
const EXIT_GAP: [number, number] = [22, 23.2];

/** Cut-away front walls: a low lip along the two near edges, open at the exit. */
function lipSprites(): Sprite[] {
  const sprites: Sprite[] = [];
  for (let y = 0; y < WORLD_D; y += 1) {
    const box = { x: WORLD_W - 0.14, y, w: 0.14, d: 1 };
    sprites.push({
      key: `lip-e-${y}`,
      depth: centreDepth(box) + 0.3,
      node: <Box key={`lip-e-${y}`} {...box} h={LIP_H} tone={PAINT.cream} className="iso-wall" />,
    });
  }
  for (let x = 0; x < WORLD_W; x += 1) {
    if (x + 1 > EXIT_GAP[0] && x < EXIT_GAP[1]) continue;
    const box = { x, y: WORLD_D - 0.14, w: 1, d: 0.14 };
    sprites.push({
      key: `lip-s-${x}`,
      depth: centreDepth(box) + 0.3,
      node: <Box key={`lip-s-${x}`} {...box} h={LIP_H} tone={PAINT.cream} className="iso-wall" />,
    });
  }
  return sprites;
}

/** Velvet ropes of the queue, hung between the posts. */
function ropeSprites(): Sprite[] {
  return [3.52, 5.72].map((y) => {
    const spans: [number, number][] = [
      [1.52, 3.32],
      [3.32, 5.12],
    ];
    const d = spans
      .map(([from, x], i) => {
        const a = project(from, y, 22);
        const b = project(x, y, 22);
        const mid = project((from + x) / 2, y, 12);
        return `${i === 0 ? `M${a.x.toFixed(1)} ${a.y.toFixed(1)}` : ''}Q${mid.x.toFixed(1)} ${mid.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
      })
      .join('');
    return {
      key: `rope-${y}`,
      depth: depthOf(3.3, y) + 0.05,
      node: <path key={`rope-${y}`} className="office-rope" d={d} />,
    };
  });
}

/** Everything that never moves, computed once. */
export const STATIC_SPRITES: Sprite[] = [
  ...furnitureSprites(),
  ...partitionSprites(),
  ...lipSprites(),
  ...ropeSprites(),
];
