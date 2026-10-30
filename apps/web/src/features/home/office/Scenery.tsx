/** The parts of the office that never change: slab, floors, back walls and what hangs on them. */
import { t } from '@/i18n';
import { Box, PAINT } from './Box';
import {
  FLOOR_MATRIX,
  NORTH_WALL_MATRIX,
  polygon,
  SLAB_H,
  WALL_H,
  WALL_TILE,
  WEST_WALL_MATRIX,
  WORLD_D,
  WORLD_W,
} from './iso';
import { FURNITURE, ROOMS } from './world';

const WALL_T = 0.3;

/** Floor textures, drawn in tile units under FLOOR_MATRIX. */
function FloorPatterns() {
  return (
    <>
      <pattern id="floor-planks" width="3" height="1" patternUnits="userSpaceOnUse">
        <rect width="3" height="1" fill={PAINT.wood} />
        <rect y="0.5" width="3" height="0.5" fill="#d29659" />
        <path
          d="M0 0H3M0 .5H3M0 0V.5M1.5 .5V1M.4 .2H1.1M2 .72H2.7"
          stroke={PAINT.woodDark}
          strokeWidth="0.035"
          fill="none"
        />
      </pattern>
      <pattern id="floor-carpet" width="0.5" height="0.5" patternUnits="userSpaceOnUse">
        <rect width="0.5" height="0.5" fill="#9ba5f2" />
        <circle cx="0.12" cy="0.12" r="0.045" fill="#7e89e0" />
        <circle cx="0.37" cy="0.37" r="0.045" fill="#b4bcf7" />
      </pattern>
      <pattern id="floor-mint" width="1" height="1" patternUnits="userSpaceOnUse">
        <rect width="1" height="1" fill={PAINT.mint} />
        <path d="M0 0H1V1" stroke="#9fd6b4" strokeWidth="0.05" fill="none" />
        <path d="M.3 .5h.4M.5 .3v.4" stroke="#d8f2e1" strokeWidth="0.04" />
      </pattern>
      <pattern id="floor-tiles" width="1" height="1" patternUnits="userSpaceOnUse">
        <rect width="1" height="1" fill={PAINT.cream} />
        <rect width="0.5" height="0.5" fill="#9ed6cf" />
        <rect x="0.5" y="0.5" width="0.5" height="0.5" fill="#9ed6cf" />
      </pattern>
      <pattern id="floor-felt" width="0.6" height="0.6" patternUnits="userSpaceOnUse">
        <rect width="0.6" height="0.6" fill="#e2c9a6" />
        <path d="M0 .6L.6 0" stroke="#cdb08a" strokeWidth="0.05" />
      </pattern>
    </>
  );
}

/** Rug, wall and grain textures. */
function DecorPatterns() {
  return (
    <>
      <pattern id="floor-zigzag" width="0.8" height="0.5" patternUnits="userSpaceOnUse">
        <rect width="0.8" height="0.5" fill={PAINT.pink} />
        <path d="M0 .35L.2 .15L.4 .35L.6 .15L.8 .35" stroke="#ffc1df" strokeWidth="0.07" fill="none" />
      </pattern>
      <pattern id="wall-paper" width="14" height="10" patternUnits="userSpaceOnUse">
        <rect width="14" height="10" fill={PAINT.cream} />
        <path d="M3 0V10" stroke="#e7dcc6" strokeWidth="5" />
        <circle cx="10" cy="5" r="1" fill="#e2d4bb" />
      </pattern>
      <pattern id="wall-tiles" width="10" height="7" patternUnits="userSpaceOnUse">
        <rect width="10" height="7" fill="#e9f5f1" />
        <path d="M0 0H10M0 0V7" stroke="#9ed6cf" strokeWidth="1.2" />
      </pattern>
      <pattern id="office-grain" width="180" height="180" patternUnits="userSpaceOnUse">
        <image
          width="180"
          height="180"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' seed='11' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .09 0 0 0 0 .07 0 0 0 0 .05 0 0 0 1.8 -.8'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23g)'/%3E%3C/svg%3E"
        />
      </pattern>
    </>
  );
}

const FLOOR_FILL: Record<string, string> = {
  carpet: 'url(#floor-carpet)',
  planks: 'url(#floor-planks)',
  mint: 'url(#floor-mint)',
  tiles: 'url(#floor-tiles)',
  felt: 'url(#floor-felt)',
  rug: 'url(#floor-planks)',
};

function Floors() {
  return (
    <g transform={FLOOR_MATRIX}>
      {ROOMS.map((room) => (
        <rect key={room.id} x={room.x} y={room.y} width={room.w} height={room.d} fill={FLOOR_FILL[room.floor]} />
      ))}
      {/* lounge rug with fringe, queue runner towards the team door */}
      <rect x="16.4" y="11.6" width="2.4" height="1.9" rx="0.08" fill="url(#floor-zigzag)" className="office-outline-thin" />
      <path d="M16.4 11.7v1.7M18.8 11.7v1.7" className="office-fringe" />
      <rect x="0.9" y="4.05" width="6.1" height="1.1" fill={PAINT.ultramarine} opacity="0.55" />
      <path d="M1 4.6H6.9" className="office-runner-line" />
      <path className="office-tile-grid" d={tileGrid()} />
    </g>
  );
}

function tileGrid(): string {
  const parts: string[] = [];
  for (let x = 1; x < WORLD_W; x += 1) parts.push(`M${x} 0V${WORLD_D}`);
  for (let y = 1; y < WORLD_D; y += 1) parts.push(`M0 ${y}H${WORLD_W}`);
  return parts.join('');
}

/** Contact shadows under furniture, so nothing floats. */
function FloorShadows() {
  return (
    <g className="office-contact">
      {FURNITURE.filter((f) => f.isSolid).map((f) => (
        <polygon
          key={f.id}
          points={polygon([
            [f.x + 0.12, f.y + 0.12],
            [f.x + f.w + 0.16, f.y + 0.12],
            [f.x + f.w + 0.16, f.y + f.d + 0.16],
            [f.x + 0.12, f.y + f.d + 0.16],
          ])}
        />
      ))}
    </g>
  );
}

function Window({ u, w }: { u: number; w: number }) {
  return (
    <g className="office-window">
      <rect x={u} y="12" width={w} height="38" className="office-sky" />
      <circle cx={u + w * 0.7} cy="24" r="5" fill={PAINT.yellow} />
      <path d={`M${u + 4} 40c6-6 12-6 18 0s12 4 16-2`} className="office-hill" />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <path key={i} d={`M${u} ${15 + i * 3.4}H${u + w}`} className="office-blind" />
      ))}
      <rect x={u} y="12" width={w} height="38" className="office-frame" />
      <path d={`M${u + w / 2} 12V50`} className="office-frame" />
    </g>
  );
}

function Sign({ u, v, text, tone }: { u: number; v: number; text: string; tone: string }) {
  const width = text.length * 7.6 + 16;
  return (
    <g className="office-sign">
      <rect x={u} y={v} width={width} height="17" rx="2" fill={tone} />
      <text x={u + 8} y={v + 12.2}>
        {text}
      </text>
    </g>
  );
}

function NorthWall() {
  const tile = (x: number) => x * WALL_TILE;
  return (
    <g transform={NORTH_WALL_MATRIX}>
      <rect x="0" y="0" width={tile(WORLD_W)} height={WALL_H} fill="url(#wall-paper)" />
      <rect x="0" y={WALL_H - 7} width={tile(WORLD_W)} height="7" className="office-skirting" />
      <Sign u={tile(0.5)} v={8} text={t('home.join.map.queue')} tone={PAINT.blue} />
      <g className="office-ticket">
        <rect x={tile(4.6)} y="12" width="44" height="22" rx="3" />
        <text x={tile(4.6) + 22} y="27">
          {t('home.join.map.ticket')}
        </text>
      </g>
      <Sign u={tile(7.4)} v={8} text={t('home.join.map.team')} tone={PAINT.yellow} />
      <Window u={tile(10.3)} w={52} />
      <g className="office-board">
        <rect x={tile(12.6)} y="16" width="34" height="26" rx="1.5" />
        <rect x={tile(12.6) + 4} y="20" width="9" height="8" fill={PAINT.pink} />
        <rect x={tile(12.6) + 16} y="21" width="9" height="8" fill={PAINT.yellow} />
        <rect x={tile(12.6) + 8} y="31" width="9" height="8" fill={PAINT.mint} />
      </g>
      <Sign u={tile(16.4)} v={8} text={t('home.join.map.trial')} tone={PAINT.mint} />
    </g>
  );
}

function WestWall() {
  const atY = (y: number) => (WORLD_D - y) * WALL_TILE;
  return (
    <g transform={WEST_WALL_MATRIX}>
      <rect x="0" y="0" width={atY(0)} height={WALL_H} fill="url(#wall-paper)" />
      <rect x={atY(12.3)} y="22" width={atY(8.5) - atY(12.3)} height="22" fill="url(#wall-tiles)" className="office-outline-thin" />
      <path d={`M${atY(12.2)} 16H${atY(10.2)}`} className="office-shelf-line" />
      {[0, 1, 2].map((i) => (
        <rect key={i} x={atY(12) + i * 11} y="9" width="7" height="7" rx="1" fill={[PAINT.pink, PAINT.yellow, PAINT.blue][i]} className="office-outline-thin" />
      ))}
      <rect x="0" y={WALL_H - 7} width={atY(0)} height="7" className="office-skirting" />
      <g className="office-door">
        <rect x={atY(5.25)} y="14" width={atY(4) - atY(5.25)} height={WALL_H - 14} />
        <path d={`M${atY(5.25)} ${WALL_H}V14H${atY(4)}V${WALL_H}`} />
      </g>
      <g className="office-poster">
        <rect x={atY(7.3)} y="14" width="34" height="26" rx="1" fill={PAINT.pink} />
        <path d={`M${atY(7.3) + 6} 32c6-12 14-12 22 0`} stroke={PAINT.ink} strokeWidth="2" fill="none" />
        <rect x={atY(2.6)} y="18" width="26" height="32" rx="1" fill={PAINT.yellow} />
        <path d={`M${atY(2.6) + 6} 26h14M${atY(2.6) + 6} 32h10M${atY(2.6) + 6} 38h12`} stroke={PAINT.ink} strokeWidth="2" />
      </g>
    </g>
  );
}

function FloorLabels() {
  const labels: { x: number; y: number; text: string }[] = [
    { x: 2, y: 13.35, text: t('home.join.map.kitchen') },
    { x: 8.4, y: 13.35, text: t('home.join.map.meeting') },
    { x: 19.6, y: 13.35, text: t('home.join.map.lounge') },
  ];
  return (
    <g transform={FLOOR_MATRIX} className="office-floor-label">
      {labels.map((label) => (
        <text key={label.text} x={label.x} y={label.y}>
          {label.text}
        </text>
      ))}
    </g>
  );
}

/** Outline of the whole diorama; clips the grain so it never lands on the page. */
export const SILHOUETTE = polygon([
  [-WALL_T, -WALL_T, WALL_H],
  [WORLD_W, -WALL_T, WALL_H],
  [WORLD_W, -WALL_T, -SLAB_H],
  [WORLD_W, WORLD_D, -SLAB_H],
  [-WALL_T, WORLD_D, -SLAB_H],
  [-WALL_T, WORLD_D, WALL_H],
]);

export function Scenery() {
  return (
    <>
      <defs>
        <FloorPatterns />
        <DecorPatterns />
        <clipPath id="office-silhouette">
          <polygon points={SILHOUETTE} />
        </clipPath>
      </defs>
      <Box x={-WALL_T} y={-WALL_T} w={WORLD_W + WALL_T} d={WORLD_D + WALL_T} h={SLAB_H} z={-SLAB_H} tone={PAINT.teal} className="iso-slab" />
      <Floors />
      <FloorLabels />
      <FloorShadows />
      <Box x={-WALL_T} y={-WALL_T} w={WORLD_W + WALL_T} d={WALL_T} h={WALL_H} tone={PAINT.cream} className="iso-backwall" />
      <Box x={-WALL_T} y={0} w={WALL_T} d={WORLD_D} h={WALL_H} tone={PAINT.cream} className="iso-backwall" />
      <NorthWall />
      <WestWall />
    </>
  );
}
