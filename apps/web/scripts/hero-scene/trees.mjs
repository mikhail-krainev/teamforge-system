// Pines: a one-polygon silhouette for the far forest and a tiered, snow-laden tree for the near one.
import { between, mix, poly, rect } from './lib.mjs';

/** Far tree: a single zig-zag triangle. */
export function tinyPine(x, base, h, colour) {
  const hw = h * 0.2;
  const tiers = 3;
  const left = [];
  const right = [];
  for (let i = 0; i < tiers; i += 1) {
    const top = base - h + (h * 0.78 * i) / tiers;
    const bottom = base - h + (h * 0.78 * (i + 1.25)) / tiers;
    const w = hw * (0.45 + (0.55 * (i + 1)) / tiers);
    left.push([x - w * 0.55, top + (bottom - top) * 0.25], [x - w, bottom]);
    right.push([x + w * 0.55, top + (bottom - top) * 0.25], [x + w, bottom]);
  }
  return poly([[x, base - h], ...right, ...left.reverse()], colour);
}

/**
 * Near tree with tiers, a lit right flank and snow on every shelf.
 * @param {{ dark: string, lit: string, snow: string, snowLit: string, tiers?: number }} o
 */
export function pine(x, base, h, rand, o) {
  const tiers = o.tiers ?? 4 + Math.floor(rand() * 3);
  const shade = between(rand, -0.12, 0.12);
  o = { ...o, dark: mix(o.dark, shade > 0 ? '#2a2060' : '#07061c', Math.abs(shade)) };
  const out = [rect(x - h * 0.018, base - h * 0.14, h * 0.036, h * 0.14, mix(o.dark, '#000000', 0.3))];
  const span = h * 0.9;
  for (let j = 0; j < tiers; j += 1) {
    const apexY = base - h + (span * j) / (tiers + 0.6);
    const by = apexY + (h * 0.4) / (1 + j * 0.12);
    const hw = h * 0.21 * (0.4 + (0.6 * (j + 1)) / tiers) * between(rand, 0.92, 1.08);
    const bottom = [
      [x + hw, by],
      [x + hw * 0.55, by - h * 0.018],
      [x + hw * 0.18, by + h * 0.004],
      [x - hw * 0.3, by - h * 0.02],
      [x - hw, by],
    ];
    out.push(poly([[x, apexY], ...bottom], o.dark));
    out.push(poly([[x, apexY], [x + hw, by], [x + hw * 0.55, by - h * 0.018], [x + hw * 0.18, by + h * 0.004], [x, by - h * 0.01]], mix(o.dark, o.lit, 0.32)));
    const drop = (by - apexY) * 0.5 * (o.snowAmount ?? 1);
    out.push(
      poly(
        [
          [x, apexY],
          [x + hw * 0.62, apexY + drop * 0.95],
          [x + hw * 0.3, apexY + drop * 0.82],
          [x + hw * 0.1, apexY + drop * 1.05],
          [x - hw * 0.25, apexY + drop * 0.85],
          [x - hw * 0.6, apexY + drop * 0.98],
        ],
        o.snow,
      ),
    );
    out.push(poly([[x, apexY], [x + hw * 0.62, apexY + drop * 0.95], [x + hw * 0.3, apexY + drop * 0.82], [x + hw * 0.1, apexY + drop * 0.7]], o.snowLit));
  }
  return out.join('');
}
