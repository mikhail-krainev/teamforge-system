/** One office worker, drawn in screen space with the feet at the origin. */
import { memo } from 'react';
import { PAINT } from './Box';
import { facingOf } from './iso';
import { SKIN_TONES, type Glyph, type Hair, type Pose, type Shirt } from './sim';

const SHIRT_FILL: Record<Shirt, string> = {
  yellow: PAINT.yellow,
  pink: PAINT.pink,
  blue: PAINT.blue,
  green: PAINT.teal,
  orange: PAINT.orange,
  mint: PAINT.mint,
  brown: PAINT.clay,
  red: PAINT.red,
};

const HAIR_FILL = ['#2b1d14', '#5a3a22', '#a5592a', '#e3b867', '#16130f'] as const;
const PANTS = ['#2d3350', '#3d3a35', '#4b5d8c', '#6b4f3a'] as const;
const SEAT_LIFT = 14;
const HEAD_Y = -33;

export interface FigureProps {
  id: number;
  shirt: Shirt;
  hair: Hair;
  skin: number;
  pose: Pose;
  /** Look direction in the world. */
  lookX: number;
  lookY: number;
  stride: number;
  isWalking: boolean;
  holdsCup: boolean;
}

function HairShape({ hair, isFront, tone }: { hair: Hair; isFront: boolean; tone: string }) {
  const y = HEAD_Y;
  switch (hair) {
    case 'bald':
      return null;
    case 'short':
      return isFront ? (
        <path d={`M-6.4 ${y}a6.4 6.4 0 0 1 12.8 0c-2-2.4-4.6-3.2-6.6-2.4-2 .8-4.4 1-6.2 2.4z`} fill={tone} />
      ) : (
        <path d={`M-6.4 ${y + 1}a6.4 6.4 0 0 1 12.8 0c0 2-.6 3.6-1.6 4.6h-9.6c-1-1-1.6-2.6-1.6-4.6z`} fill={tone} />
      );
    case 'bun':
      return (
        <>
          <circle cx="-1" cy={y - 7.6} r="3.2" fill={tone} />
          <path
            d={isFront ? `M-6.4 ${y}a6.4 6.4 0 0 1 12.8 0c-3-1.6-9.8-1.6-12.8 0z` : `M-6.4 ${y + 1}a6.4 6.4 0 0 1 12.8 0c0 2.4-1 4.4-2 5h-8.8c-1-.6-2-2.6-2-5z`}
            fill={tone}
          />
        </>
      );
    case 'long':
      return (
        <path
          d={
            isFront
              ? `M-7 ${y + 9}c-1.6-6-1.4-11 1-13.6 3.4-3.6 9.6-3.6 12.4 0 2.4 2.6 2.6 7.6 1 13.6l-2-.4c.6-4 .4-7.2-.8-9.4-2.6 1.4-6.6 1.6-9.6.2-1 2.4-1.2 5.4-.6 9.2z`
              : `M-7 ${y + 9}c-1.6-6-1.4-11 1-13.6 3.4-3.6 9.6-3.6 12.4 0 2.4 2.6 2.6 7.6 1 13.6z`
          }
          fill={tone}
        />
      );
    case 'cap':
      return (
        <>
          <path d={`M-6.6 ${y - 0.6}a6.6 6.6 0 0 1 13.2 0z`} fill={PAINT.ultramarine} />
          {isFront && <path d={`M2 ${y - 1}h8.4c0 1.4-1.2 2-2.4 2H2z`} fill={PAINT.ultramarine} />}
        </>
      );
    case 'curly':
      return (
        <path
          d={`M-7 ${y + (isFront ? 0 : 3)}c-2-3 0-6 2-6.4 0-2.6 3.4-3.8 5-2.4 1.6-1.6 5-.8 5.4 1.6 2.6.2 3.6 3.6 1.6 5.2 1 1.2.4 ${isFront ? '2' : '4.6'}-1 ${isFront ? '2' : '5.4'}H-5.6c-1.4-.4-2-1.4-1.4-${isFront ? '0' : '2.6'}z`}
          fill={tone}
        />
      );
  }
}

function Legs({ pose, swing, pants }: { pose: Pose; swing: number; pants: string }) {
  if (pose === 'sit' || pose === 'type') {
    return (
      <g className="fig-line" fill={pants}>
        <path d="M-5 -2h11.5a2.4 2.4 0 0 1 0 4.8H-5z" />
        <path d="M5.5 2.6v7.6" stroke={pants} strokeWidth="3.4" />
      </g>
    );
  }
  const lift = (s: number) => Math.max(0, s) * 1.6;
  return (
    <g className="fig-line" fill={pants}>
      <rect x={-4.2 + swing * 2.2} y={-13 - lift(swing)} width="3.8" height={13} rx="1.4" />
      <rect x={0.6 - swing * 2.2} y={-13 - lift(-swing)} width="3.8" height={13} rx="1.4" />
    </g>
  );
}

function Arms({
  pose,
  swing,
  shirt,
  skin,
  holdsCup,
}: {
  pose: Pose;
  swing: number;
  shirt: string;
  skin: string;
  holdsCup: boolean;
}) {
  const front = pose === 'type' ? { x: 9, y: -17 } : { x: 6.8 + swing * 3, y: -12 };
  const back = pose === 'type' ? { x: 8, y: -15 } : pose === 'swing' ? { x: 12, y: -22 } : { x: -6.8 - swing * 3, y: -12 };
  const arm = (to: { x: number; y: number }, from: number, key: string) => (
    <g key={key}>
      <path d={`M${from} -23L${to.x.toFixed(1)} ${to.y.toFixed(1)}`} className="fig-sleeve-out" />
      <path d={`M${from} -23L${to.x.toFixed(1)} ${to.y.toFixed(1)}`} stroke={shirt} className="fig-sleeve" />
      <circle cx={to.x.toFixed(1)} cy={to.y.toFixed(1)} r="2" fill={skin} className="fig-line" />
    </g>
  );
  return (
    <>
      {arm(back, -5, 'back')}
      {arm(front, 5, 'front')}
      {pose === 'swing' && <ellipse cx="14" cy="-24" rx="3.6" ry="4.4" fill={PAINT.red} className="fig-line" />}
      {holdsCup && pose !== 'type' && (
        <rect x={front.x - 2} y={front.y - 6} width="4.4" height="5" rx="1" fill={PAINT.cream} className="fig-line" />
      )}
    </>
  );
}

function FigureImpl({ id, shirt, hair, skin, pose, lookX, lookY, stride, isWalking, holdsCup }: FigureProps) {
  const { isFlipped, isFront } = facingOf(lookX, lookY);
  const swing = isWalking ? Math.sin(stride) : pose === 'swing' ? Math.sin(stride) * 0.4 : 0;
  const bob = isWalking ? Math.abs(Math.cos(stride)) * -1.4 : 0;
  const isSeated = pose === 'sit' || pose === 'type';
  const lift = isSeated ? -SEAT_LIFT : 0;
  const skinTone = SKIN_TONES[skin] ?? SKIN_TONES[0];
  const hairTone = HAIR_FILL[id % HAIR_FILL.length] ?? HAIR_FILL[0];
  const pants = PANTS[(id * 7) % PANTS.length] ?? PANTS[0];
  const shirtFill = SHIRT_FILL[shirt];
  const typing = pose === 'type' ? Math.sin(stride * 3) * 0.6 : 0;
  return (
    <g className="fig">
      <ellipse className="fig-shadow" cx="0" cy="0" rx="9" ry="4.2" />
      <g transform={`translate(0 ${(lift + bob + typing).toFixed(2)})${isFlipped ? ' scale(-1 1)' : ''}`}>
        <Legs pose={pose} swing={swing} pants={pants} />
        {!isFront && <Arms pose={pose} swing={swing} shirt={shirtFill} skin={skinTone} holdsCup={holdsCup} />}
        <path
          className="fig-line"
          fill={shirtFill}
          d="M-6.6 -24.4c0-2.4 1.6-3.6 4-3.6h5.2c2.4 0 4 1.2 4 3.6l-.6 11.6c0 .9-.7 1.4-1.6 1.4H-5.4c-.9 0-1.6-.5-1.6-1.4z"
        />
        {isFront && <path d="M-2.2 -28l2.2 2.6 2.2-2.6" className="fig-collar" />}
        {isFront && <Arms pose={pose} swing={swing} shirt={shirtFill} skin={skinTone} holdsCup={holdsCup} />}
        <circle cx="0" cy={HEAD_Y} r="6.4" fill={skinTone} className="fig-line" />
        {isFront && (
          <g className="fig-face">
            <circle cx="1.2" cy={HEAD_Y + 0.2} r="0.95" />
            <circle cx="4.2" cy={HEAD_Y + 0.2} r="0.95" />
            <path d={`M1.8 ${HEAD_Y + 3}q1.2 1 2.4 0`} className="fig-smile" />
          </g>
        )}
        <HairShape hair={hair} isFront={isFront} tone={hairTone} />
        <circle cx="0" cy={HEAD_Y} r="6.4" className="fig-head-ring" />
      </g>
    </g>
  );
}

export const Figure = memo(FigureImpl);

const GLYPHS: Record<Glyph, string> = {
  dots: '',
  code: '</>',
  heart: '',
  cup: '',
  idea: '!',
  bug: '',
  check: '',
  question: '?',
};

/** Little picture inside a speech bubble. */
export function GlyphMark({ glyph }: { glyph: Glyph }) {
  switch (glyph) {
    case 'dots':
      return (
        <g fill={PAINT.ink}>
          <circle cx="-5" cy="0" r="1.6" />
          <circle cx="0" cy="0" r="1.6" />
          <circle cx="5" cy="0" r="1.6" />
        </g>
      );
    case 'heart':
      return <path d="M0 4.6l-5-4.8a3 3 0 0 1 5-3.4 3 3 0 0 1 5 3.4z" fill={PAINT.pink} className="fig-line" />;
    case 'cup':
      return (
        <g className="fig-line">
          <path d="M-5-3h8v5a3 3 0 0 1-3 3h-2a3 3 0 0 1-3-3z" fill={PAINT.cream} />
          <path d="M3-1.6h1.4a1.6 1.6 0 0 1 0 3.2H3" fill="none" />
        </g>
      );
    case 'bug':
      return (
        <g className="fig-line">
          <ellipse cx="0" cy="0.6" rx="3.6" ry="4.4" fill={PAINT.red} />
          <path d="M-3.6-1h-2.6M3.6-1h2.6M-3.4 2.6h-2.6M3.4 2.6h2.6M0-3.8v8.8" fill="none" />
        </g>
      );
    case 'check':
      return <path d="M-5 0l3.4 3.4L5.4-3.6" fill="none" stroke={PAINT.teal} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />;
    default:
      return (
        <text className="fig-glyph" y="3.8">
          {GLYPHS[glyph]}
        </text>
      );
  }
}
