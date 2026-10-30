// Builds the landing hero scene: an evening ski resort under snow peaks, a city glowing far below.
// Run: node scripts/hero-scene/index.mjs   (writes the SVGs into src/features/home/scene/)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { between, circle, line, mulberry32, pick } from './lib.mjs';
import { city, forestHill, lift, onPiste, paletteTree, piste, ridge } from './land.mjs';
import { mountain } from './mountain.mjs';
import { cabin, drift, festoon, lamp, village } from './place.mjs';
import { fx } from './fx.mjs';
import { pageScenery } from './page.mjs';
import { H, W, sky, skyAt } from './sky.mjs';
import { pine } from './trees.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../../src/features/home/scene');

const rand = mulberry32(20261031);
const { defs, body: skyBody } = sky(rand);

const far = [
  mountain({ apex: [120, 505], baseL: [-160, 720], baseR: [430, 720], rand, ridges: 4, centre: 0.7, sunward: 0.5, fog: skyAt(560), fogAmount: 0.7, detail: false, rough: 0.03 }),
  mountain({ apex: [520, 565], baseL: [290, 720], baseR: [790, 720], rand, ridges: 4, centre: 0.7, sunward: 0.5, fog: skyAt(600), fogAmount: 0.76, detail: false, rough: 0.03 }),
  mountain({ apex: [1480, 330], baseL: [1080, 735], baseR: [1900, 735], rand, ridges: 6, centre: 0.4, sunward: 1, fog: skyAt(420), fogAmount: 0.3, rough: 0.03, bendL: 1.5, bendR: 1.4 }),
  mountain({ apex: [980, 300], baseL: [690, 730], baseR: [1270, 730], rand, ridges: 6, centre: 0.55, sunward: 0.9, fog: skyAt(470), fogAmount: 0.34, rough: 0.03, bendL: 1.45 }),
  mountain({ apex: [1190, 110], baseL: [700, 740], baseR: [1760, 740], rand, ridges: 9, centre: 0.42, sunward: 1, fog: skyAt(300), fogAmount: 0.04, rough: 0.04, bendL: 1.12, bendR: 1.08 }),
].join('');

const cityLayer = city(rand);

const hillA = forestHill(
  [[-20, 722], [200, 716], [430, 722], [640, 716], [820, 694], [1000, 660], [1250, 610], [1450, 590], [1640, 596]],
  rand,
  { ground: '#262051', tree: paletteTree(rand, ['#1d1844', '#221c4b', '#1a163e']), density: 0.34, size: 22, skip: onPiste },
);

const hillB = forestHill(
  [[-20, 800], [260, 786], [520, 800], [760, 784], [900, 772], [1180, 782], [1420, 796], [1640, 800]],
  rand,
  { ground: '#1a1640', tree: paletteTree(rand, ['#15123a', '#18143e', '#120f33']), density: 0.3, size: 34 },
);

const resort = village(rand);

const treeOpts = { dark: '#15123a', lit: '#ff9a6a', snow: '#a99fd6', snowLit: '#ffe2c4' };

/** A loose group of pines: uneven spacing, heights and snow load, drawn back to front. */
function grove(cx, base, count, spread, hMin, hMax) {
  const trees = [];
  for (let i = 0; i < count; i += 1) {
    trees.push([cx + (rand() - 0.5) * spread, base + between(rand, -6, 8), between(rand, hMin, hMax)]);
  }
  return trees.sort((p, q) => p[1] - q[1]).map(([x, y, h]) => pine(x, y, h, rand, treeOpts));
}

const nearTrees = [...grove(360, 842, 5, 170, 90, 190), ...grove(1075, 838, 6, 190, 80, 180)];

const ripples = (crest, tone) =>
  [18, 34, 54].map((off, k) =>
    line(crest.filter((_, i) => i % 2 === 0).map(([x, y], i) => [x, y + off + Math.sin(i * 0.9 + k) * 4]), tone, 1.2, ' opacity=".35"'),
  ).join('');

const crest1 = ridge([[-20, 852], [160, 842], [330, 858], [520, 846], [700, 860], [900, 848], [1150, 858], [1400, 844], [1620, 850]], rand, { step: 26, noise: 3 });
const crest2 = ridge([[-20, 908], [200, 892], [420, 912], [640, 898], [860, 914], [1100, 896], [1360, 908], [1620, 892]], rand, { step: 26, noise: 3 });
const crest3 = ridge([[-20, 962], [260, 946], [520, 968], [800, 950], [1080, 966], [1360, 948], [1620, 960]], rand, { step: 26, noise: 3 });

const snow = [
  drift(crest1, '#4a4f9e', '#c79ec5', '#2f3377', rand),
  ripples(crest1, '#7378c8'),
  drift(crest2, '#3a3e88', '#b58cc0', '#26296a', rand),
  ripples(crest2, '#6268b8'),
  drift(crest3, '#2b2e72', '#8f7fc0', '#1d1f58', rand),
  ripples(crest3, '#4d52a0'),
].join('');

const nearCabin = cabin(660, 906);
const nearLamp = lamp(626, 910);
const lights = festoon([626, 800], [690, 826], 12, 8, rand);

const rimWarm = line(ridge([[420, 852], [640, 846], [900, 850]], rand, { step: 30, noise: 3 }), '#ffcf94', 2.4, ' opacity=".5"');

const tracks = [0, 9].map((dx) =>
  line([[300 + dx, 1000], [420 + dx, 962], [560 + dx, 940], [700 + dx, 926], [840 + dx, 914], [960 + dx, 900]], '#262a6c', 2.2, ' opacity=".55"'),
).join('');

const glitter = [];
for (let i = 0; i < 160; i += 1) {
  glitter.push(circle(between(rand, 0, W), between(rand, 850, 1000), between(rand, 0.5, 1.2), pick(rand, ['#fff1dd', '#cfd2ff', '#ffd6e6']), ` opacity="${between(rand, 0.35, 0.9).toFixed(2)}"`));
}

const edgePines = [
  pine(-6, 1010, 360, rand, { dark: '#110e30', lit: '#ff9a6a', snow: '#a99fd6', snowLit: '#ffe2c4' }),
  pine(1592, 1000, 400, rand, { dark: '#110e30', lit: '#ffb27a', snow: '#a99fd6', snowLit: '#ffe2c4' }),
].join('');

const skis = [
  line([[641, 910], [657, 818]], '#ff5a1f', 3.2),
  line([[648, 912], [664, 820]], '#ffc93c', 3.2),
].join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice"><defs>${defs}</defs>${skyBody}${far}${cityLayer.svg}${hillA.svg}${piste()}${lift()}${resort.svg}${hillB.svg}${nearTrees.join('')}${snow}${tracks}${edgePines}${nearCabin.svg}${rimWarm}${skis}${nearLamp}${lights}${glitter.join('')}</svg>`;

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'hero-scene.svg'), svg);
const fxSvg = fx(mulberry32(7), { smoke: resort.smoke, towers: cityLayer.towers, cabinChimney: nearCabin.chimney });
writeFileSync(resolve(outDir, 'hero-scene-fx.svg'), fxSvg);
for (const [name, text] of Object.entries(pageScenery())) writeFileSync(resolve(outDir, name), text);
process.stdout.write(`hero-scene.svg ${(svg.length / 1024).toFixed(0)} KB, fx ${(fxSvg.length / 1024).toFixed(0)} KB\n`);
