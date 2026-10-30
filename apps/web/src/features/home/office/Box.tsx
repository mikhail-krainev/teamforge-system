import type { CSSProperties, ReactNode } from 'react';
import { boxFaces, corner } from './iso';

/** Office palette. Fixed colours: the office is a printed object and keeps them in both themes. */
export const PAINT = {
  ink: '#16130f',
  cream: '#f6f1e7',
  paper: '#fbf8f2',
  wood: '#d9a066',
  woodDark: '#a86f3e',
  teal: '#2fa4a0',
  pink: '#ff6fb5',
  yellow: '#ffc93c',
  blue: '#8c9bff',
  mint: '#b8e6c9',
  orange: '#ffa36c',
  red: '#ff5a1f',
  grey: '#d8cfbd',
  steel: '#6f6a62',
  screen: '#26304f',
  clay: '#c77b4f',
  leaf: '#3c9a5a',
  leafLight: '#7cc47a',
  ultramarine: '#3a47d5',
} as const;

interface BoxProps {
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  z?: number;
  tone: string;
  className?: string;
  children?: ReactNode;
}

/** An outlined block: lit top, mid east side, shaded south side. Children draw on top of it. */
export function Box({ x, y, w, d, h, z = 0, tone, className, children }: BoxProps) {
  const faces = boxFaces(x, y, w, d, h, z);
  return (
    <g className={className ? `iso ${className}` : 'iso'} style={{ '--c': tone } as CSSProperties}>
      <polygon className="iso-s" points={faces.south} />
      <polygon className="iso-e" points={faces.east} />
      <polygon className="iso-t" points={faces.top} />
      {children}
    </g>
  );
}

/** A straight stroke between two world points. */
export function Seg({
  a,
  b,
  className,
}: {
  a: [number, number, number];
  b: [number, number, number];
  className?: string;
}) {
  const [x1, y1] = corner(...a).split(',');
  const [x2, y2] = corner(...b).split(',');
  return <line className={className} x1={x1} y1={y1} x2={x2} y2={y2} />;
}
