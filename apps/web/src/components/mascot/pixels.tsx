import './mascot.css';

/** Cell char -> palette class from mascot.css. */
const PALETTE: Record<string, string> = {
  F: 'yeti-fur',
  S: 'yeti-shade',
  B: 'yeti-face',
  K: 'yeti-ink',
  E: 'yeti-eye',
  C: 'yeti-cheek',
  R: 'px-red',
  O: 'px-orange',
  Y: 'px-yellow',
  W: 'px-wood',
  P: 'px-pink',
  U: 'px-ultramarine',
  G: 'px-green',
  M: 'px-mint',
  L: 'px-paper',
  N: 'px-line',
};

type Run = { x: number; y: number; width: number };

/** Merges each row's equal neighbouring cells into runs, grouped by palette char ('.' is empty). */
function toRuns(grid: readonly string[]): Map<string, Run[]> {
  const runs = new Map<string, Run[]>();
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const cell = row[x] ?? '.';
      let end = x + 1;
      while (row[end] === cell) end += 1;
      if (cell !== '.') runs.set(cell, [...(runs.get(cell) ?? []), { x, y, width: end - x }]);
      x = end;
    }
  });
  return runs;
}

/** Renders a pixel grid as one crisp SVG; decorative unless `title` is given. */
export function PixelSprite({
  grid,
  size,
  title,
  className,
}: {
  grid: readonly string[];
  size: number;
  title?: string;
  className?: string;
}) {
  const width = grid[0]?.length ?? 0;
  const height = grid.length;
  const a11y = title
    ? ({ role: 'img' } as const)
    : ({ 'aria-hidden': true, focusable: 'false' } as const);
  return (
    <svg
      className={className}
      width={size}
      height={(size * height) / width}
      viewBox={`0 0 ${width} ${height}`}
      shapeRendering="crispEdges"
      {...a11y}
    >
      {title ? <title>{title}</title> : null}
      {[...toRuns(grid)].map(([cell, cellRuns]) => (
        <g key={cell} className={PALETTE[cell]}>
          {cellRuns.map((run) => (
            <rect key={`${run.x}-${run.y}`} x={run.x} y={run.y} width={run.width} height={1} />
          ))}
        </g>
      ))}
    </svg>
  );
}
