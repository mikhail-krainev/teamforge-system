// Dusk sky: flat ink bands with halftone steps between them, stars, a crescent moon and a stepped
// glow where the sun has just gone (docs/design/motion-brief.md: flat fills, no gradients).
import { between, circle, num, rect } from './lib.mjs';

export const W = 1600;
export const H = 1000;
export const HORIZON = 655;

const BANDS = [
  [0, '#10123a'],
  [110, '#171a4a'],
  [210, '#20235a'],
  [300, '#2c2b6c'],
  [380, '#3d3379'],
  [450, '#58407f'],
  [515, '#7f4a80'],
  [570, '#b05a7c'],
  [615, '#dc7274'],
  [655, '#f59a6b'],
];

/** Colour of the sky at a given height, for hazing things that stand in front of it. */
export function skyAt(y) {
  let colour = BANDS[0][1];
  for (const [from, c] of BANDS) if (y >= from) colour = c;
  return colour;
}

function halftoneStrip(id, colour, dot) {
  return `<pattern id="${id}" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="${dot}" fill="${colour}"/><circle cx="6" cy="6" r="${dot}" fill="${colour}"/></pattern>`;
}

/** Soft light: a blurred shape reads as glow, where stacked flat discs read as rings. */
export const FILTERS = ['glow-s:3', 'glow-m:7', 'glow-l:16']
  .map((f) => {
    const [id, dev] = f.split(':');
    return `<filter id="${id}" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="${dev}"/></filter>`;
  })
  .join('');

export function sky(rand) {
  const defs = [FILTERS];
  const body = [];
  BANDS.forEach(([from, colour], i) => {
    const to = i + 1 < BANDS.length ? BANDS[i + 1][0] : 720;
    body.push(rect(0, from, W, to - from + 1, colour));
    if (i === 0) return;
    [
      [8, 1.2],
      [20, 2.4],
    ].forEach(([lift, dot], s) => {
      const id = `ht${i}_${s}`;
      defs.push(halftoneStrip(id, colour, dot));
      body.push(rect(0, from - 30 + lift, W, 12, `url(#${id})`));
    });
  });

  const stars = [];
  for (let i = 0; i < 150; i += 1) {
    const y = Math.pow(rand(), 1.7) * 470;
    const r = rand() < 0.08 ? between(rand, 1.4, 2.1) : between(rand, 0.55, 1.2);
    const x = rand() * W;
    stars.push(circle(x, y, r, y > 300 ? '#ffe9d2' : '#f4f1ff', ` opacity="${num(between(rand, 0.35, 0.95))}"`));
  }
  body.push(`<g>${stars.join('')}</g>`);

  const [mx, my, mr] = [1430, 140, 26];
  body.push(circle(mx, my, mr * 2.4, '#f6f1e7', ' opacity=".16" filter="url(#glow-l)"'));
  body.push(
    `<path d="M${mx + 6} ${my - mr} A${mr} ${mr} 0 1 0 ${mx + 6} ${my + mr} A${mr * 0.78} ${mr * 0.9} 0 1 1 ${mx + 6} ${my - mr}Z" fill="#fff3d9"/>`,
  );

  return { defs: defs.join(''), body: body.join('') };
}
