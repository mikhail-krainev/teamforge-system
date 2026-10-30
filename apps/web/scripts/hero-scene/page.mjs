// Pieces of the night scenery behind the rest of the landing page: forest walls down both edges,
// a star tile, strings of lights, a ridge band with a gondola, the valley at the foot, falling snow.
// Run through index.mjs; every file lands next to hero-scene.svg.
import { between, circle, line, mulberry32, pick, rect } from './lib.mjs';
import { CSS, chairs, snowLayer } from './fx.mjs';
import { city, fillBelow, forestHill, paletteTree, ridge } from './land.mjs';
import { mountain } from './mountain.mjs';
import { cabin, chalet, drift, festoon, lamp } from './place.mjs';
import { FILTERS } from './sky.mjs';
import { pine, tinyPine } from './trees.mjs';

const NIGHT = '#10123a';

const doc = (w, h, body, { css = '', par = 'xMidYMid slice' } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="${par}"><defs>${FILTERS}</defs>${css ? `<style>@media (prefers-reduced-motion:no-preference){${css}}</style>` : ''}${body}</svg>`;

/** Forest wall for one page edge. Every tree is drawn three times so the tile joins itself. */
function forestStrip(seed, side) {
  const [w, h] = [440, 1500];
  const rand = mulberry32(seed);
  const flip = (x) => (side === 'left' ? x : w - x);
  const front = { dark: '#0c0a28', lit: '#3d3a8a', snow: '#5d5aa6', snowLit: '#a99ac4', snowAmount: 0.5 };
  const layers = [
    { n: 30, x: [10, 270], h: [150, 250], draw: (t, y, r) => tinyPine(t.x, y, t.h, pick(r, ['#14113f', '#181448', '#110e36'])) },
    { n: 8, x: [-20, 150], h: [300, 430], draw: (t, y, r) => pine(t.x, y, t.h, r, front) },
  ];
  const out = [];
  layers.forEach((layer) => {
    const trees = Array.from({ length: layer.n }, () => ({
      x: flip(between(rand, ...layer.x)),
      y: rand() * h,
      h: between(rand, ...layer.h),
      seed: Math.floor(rand() * 1e9),
    })).sort((a, b) => a.y - b.y);
    trees.forEach((t) => {
      [-h, 0, h].forEach((shift) => {
        if (t.y + shift - t.h > h || t.y + shift < 0) return;
        out.push(layer.draw(t, t.y + shift, mulberry32(t.seed)));
      });
    });
  });
  return doc(w, h, out.join(''), { par: 'xMinYMin slice' });
}

function starTile() {
  const rand = mulberry32(77);
  const out = [];
  for (let i = 0; i < 46; i += 1) {
    out.push(circle(rand() * 900, rand() * 900, between(rand, 0.5, 1.3), pick(rand, ['#f4f1ff', '#ffe9d2', '#cfd2ff']), ` opacity="${between(rand, 0.3, 0.85).toFixed(2)}"`));
  }
  for (let i = 0; i < 5; i += 1) {
    const [x, y] = [rand() * 900, rand() * 900];
    out.push(rect(x - 5, y - 0.5, 10, 1, '#fff6e6', ' opacity=".7"'), rect(x - 0.5, y - 5, 1, 10, '#fff6e6', ' opacity=".7"'), circle(x, y, 1.4, '#fff6e6'));
  }
  return doc(900, 900, out.join(''));
}

/** Warm bulbs on a sagging wire across the whole width; they flicker slowly. */
function stringLights() {
  const rand = mulberry32(31);
  const swags = [[-20, 14, 560, 22, 60], [560, 22, 1130, 12, 68], [1130, 12, 1620, 24, 56]];
  const out = [];
  swags.forEach(([x0, y0, x1, y1, sag]) => {
    out.push(festoon([x0, y0], [x1, y1], sag, Math.round((x1 - x0) / 44), rand, undefined, '#34336f'));
  });
  const bulbs = [];
  for (let i = 0; i < 10; i += 1) {
    bulbs.push(`<g class="fl" style="--l:-${(rand() * 6).toFixed(1)}s">${circle(60 + i * 160 + rand() * 60, 40 + Math.sin(i) * 20, 2, '#fff0c4')}</g>`);
  }
  return doc(1600, 150, out.join(''), {
    css: '.fl{animation:fl 3.4s ease-in-out var(--l) infinite alternate}@keyframes fl{from{opacity:.35}to{opacity:1}}',
  });
}

/** Low peaks in blue hour with a gondola climbing to the middle summit. */
function ridgeBand() {
  const rand = mulberry32(404);
  const [w, h] = [1600, 460];
  const peaks = [
    mountain({ apex: [240, 220], baseL: [-120, h], baseR: [640, h], rand, ridges: 5, centre: 0.5, sunward: 0.7, fog: NIGHT, fogAmount: 0.45, rough: 0.035, bendL: 1.15, bendR: 1.1 }),
    mountain({ apex: [1380, 200], baseL: [1000, h], baseR: [1800, h], rand, ridges: 5, centre: 0.5, sunward: 0.7, fog: NIGHT, fogAmount: 0.4, rough: 0.035, bendL: 1.15, bendR: 1.1 }),
    mountain({ apex: [820, 110], baseL: [380, h], baseR: [1260, h], rand, ridges: 7, centre: 0.45, sunward: 0.9, fog: NIGHT, fogAmount: 0.15, rough: 0.04, bendL: 1.12, bendR: 1.1 }),
  ];
  const crest = ridge([[-20, 420], [300, 410], [620, 424], [900, 412], [1250, 420], [1620, 408]], rand, { step: 18, noise: 4 });
  const trees = [];
  for (let x = -10; x < 1610; x += 3.2) trees.push(tinyPine(x + between(rand, -2, 2), 436 + between(rand, 0, 18), between(rand, 20, 40), pick(rand, ['#0f0d30', '#120f36', '#0c0a28'])));
  const from = [150, 392];
  const to = [800, 150];
  const towers = [0.25, 0.5, 0.75].map((t) => {
    const [x, y] = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
    return `${line([[x, y + 16], [x, y - 4]], '#0c0a28', 1.8)}${line([[x - 5, y - 4], [x + 5, y + 6]], '#0c0a28', 1.4)}`;
  });
  const cable = [line([from, to], '#0c0a28', 1.1, ' opacity=".9"'), line([[from[0], from[1] + 8], [to[0], to[1] + 8]], '#0c0a28', 1.1, ' opacity=".9"')];
  const station = `${rect(from[0] - 9, from[1] - 2, 18, 22, '#0f0d2e')}${rect(from[0] - 4, from[1] + 2, 5, 5, '#ffc561')}${rect(to[0] - 7, to[1] - 4, 14, 14, '#0f0d2e')}${rect(to[0] - 3, to[1], 4, 4, '#ffc561')}`;
  const body = [...peaks, fillBelow(crest, '#0d0c2a'), ...trees, ...cable, ...towers, station, `<clipPath id="gc"><rect x="${from[0]}" y="0" width="${to[0] - from[0]}" height="${h}"/></clipPath>`, `<g clip-path="url(#gc)">${chairs(from, to, 48, 'up', 0)}${chairs(from, to, 48, 'down', 8)}</g>`];
  return doc(w, h, body.join(''), { css: CSS, par: 'xMidYMax meet' });
}

/** The foot of the page: the village seen from the other side, drifts, a cabin, a lamp. */
function valley() {
  const rand = mulberry32(909);
  const [w, h] = [1600, 360];
  const cityLayer = city(rand);
  const hill = forestHill([[-20, 722], [300, 712], [640, 720], [900, 706], [1200, 716], [1640, 710]], rand, { ground: '#1d1a4a', tree: paletteTree(rand, ['#17133f', '#1b1745', '#130f36']), density: 0.34, size: 24 });
  const lots = [[250, 768, 44, 36], [310, 772, 56, 46], [392, 766, 36, 31], [446, 774, 48, 40], [520, 770, 40, 34]];
  const huts = lots.map(([x, base, wd, ht], i) => chalet(x, base, wd, ht, rand, { windows: wd > 44 ? 3 : 2, chimney: i % 2 === 0 }).svg);
  const hillB = forestHill([[-20, 806], [380, 792], [760, 804], [1100, 790], [1640, 800]], rand, { ground: '#15123a', tree: paletteTree(rand, ['#110e32', '#140f36']), density: 0.3, size: 36 });
  const crests = [
    ridge([[-20, 860], [260, 846], [560, 866], [900, 852], [1240, 862], [1620, 848]], rand, { step: 26, noise: 3 }),
    ridge([[-20, 912], [320, 896], [700, 918], [1060, 900], [1620, 912]], rand, { step: 26, noise: 3 }),
  ];
  const snow = [drift(crests[0], '#3a3e88', '#b58cc0', '#26296a', rand), drift(crests[1], '#2b2e72', '#8f7fc0', '#1d1f58', rand)].join('');
  const hut = cabin(1130, 912);
  const pines = [1010, 1060, 1440, 1500].map((x, i) => pine(x, 880 + (i % 2) * 8, between(rand, 110, 190), rand, { dark: '#0e0c2c', lit: '#ff9a6a', snow: '#a99fd6', snowLit: '#ffe2c4' }));
  const far = [[400, 660, 220, 0.78], [1090, 646, 260, 0.74], [1440, 668, 200, 0.8]].map(([x, y, half, fog]) =>
    mountain({ apex: [x, y], baseL: [x - half, 730], baseR: [x + half, 730], rand, ridges: 4, centre: 0.6, sunward: 0.5, fog: NIGHT, fogAmount: fog, detail: false, rough: 0.03 }),
  );
  const scene = `${far.join('')}${cityLayer.svg}${hill.svg}${huts.join('')}${hillB.svg}${pines.join('')}${snow}${hut.svg}${lamp(1096, 916)}`;
  return doc(w, h, `<g transform="translate(0 -640)">${scene}</g>`, { css: CSS, par: 'xMidYMax slice' });
}

function snowfall() {
  const rand = mulberry32(5);
  const body = [snowLayer(rand, 30, 0.9, 1.6, 36, 9, 0.5), snowLayer(rand, 22, 1.6, 2.6, 24, 7, 0.7), snowLayer(rand, 9, 2.8, 4, 15, 6, 0.8)].join('');
  return doc(1600, 1000, body, { css: CSS });
}

/** @returns {Record<string, string>} file name to SVG text */
export function pageScenery() {
  return {
    'forest-left.svg': forestStrip(11, 'left'),
    'forest-right.svg': forestStrip(23, 'right'),
    'stars.svg': starTile(),
    'string-lights.svg': stringLights(),
    'ridge-band.svg': ridgeBand(),
    'valley.svg': valley(),
    'snowfall.svg': snowfall(),
  };
}
