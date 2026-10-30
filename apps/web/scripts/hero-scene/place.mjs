// The resort: chalets and an A-frame with warm windows, the near cabin, drifts, lamp and festoon lights.
import { circle, line, poly, rect } from './lib.mjs';

const WALL = ['#2b2152', '#352a5e'];
const ROOF = '#1a1637';
const ROOF_SNOW = '#b6aadd';
const ROOF_SNOW_LIT = '#ffdcbc';
const WINDOW = '#ffc561';
const WINDOW_HOT = '#fff0c4';

function window_(x, y, w, h, out) {
  out.push(rect(x - w * 0.4, y - h * 0.3, w * 1.8, h * 1.6, '#ffb04a', ' opacity=".34" filter="url(#glow-s)"'));
  out.push(rect(x, y, w, h, WINDOW));
  out.push(rect(x, y, w, h * 0.34, WINDOW_HOT, ' opacity=".7"'));
  out.push(rect(x + w / 2 - 0.4, y, 0.8, h, '#6b3b2a', ' opacity=".55"'));
}

/** Gable-front chalet; returns markup and the chimney top for the smoke. */
export function chalet(x, base, w, h, rand, { windows = 3, chimney = true } = {}) {
  const out = [];
  const roofH = w * 0.46;
  const over = w * 0.09;
  const top = base - h;
  out.push(rect(x, top, w, h, WALL[rand() < 0.5 ? 0 : 1]));
  out.push(rect(x + w * 0.62, top, w * 0.38, h, '#000000', ' opacity=".14"'));
  if (chimney) out.push(rect(x + w * 0.66, top - roofH * 0.82, w * 0.12, roofH * 0.7, '#241c47'));
  out.push(poly([[x - over, top + 1], [x + w / 2, top - roofH], [x + w + over, top + 1]], ROOF));
  out.push(poly([[x - over, top + 1], [x + w / 2, top - roofH], [x + w / 2, top - roofH + w * 0.07], [x - over + w * 0.06, top + 1 - w * 0.03]], ROOF_SNOW));
  out.push(poly([[x + w / 2, top - roofH], [x + w + over, top + 1], [x + w + over - w * 0.05, top + 1 + w * 0.02], [x + w / 2 + w * 0.02, top - roofH + w * 0.08]], ROOF_SNOW_LIT));
  const ww = Math.max(3, w * 0.13);
  const wh = Math.max(4, h * 0.3);
  for (let i = 0; i < windows; i += 1) {
    const wx = x + w * ((i + 0.65) / (windows + 0.3)) - ww / 2;
    if (rand() < 0.86) window_(wx, top + h * 0.2, ww, wh, out);
  }
  if (h > 26) out.push(rect(x + w * 0.1, base - h * 0.34, w * 0.14, h * 0.34, '#f3a64c'));
  return { svg: out.join(''), chimney: chimney ? [x + w * 0.72, top - roofH * 0.82] : null };
}

/** A-frame hut: one big triangle with a glowing window. */
export function aFrame(x, base, w, h) {
  const out = [];
  out.push(poly([[x - w * 0.08, base], [x + w / 2, base - h], [x + w * 1.08, base]], ROOF));
  out.push(poly([[x + w / 2, base - h], [x + w * 1.08, base], [x + w * 1.0, base], [x + w / 2 + 1, base - h + 4]], ROOF_SNOW_LIT, ' opacity=".9"'));
  out.push(poly([[x + w * 0.22, base], [x + w / 2, base - h * 0.74], [x + w * 0.78, base]], '#3a2a54'));
  out.push(circle(x + w / 2, base - h * 0.34, w * 0.42, '#ffb04a', ' opacity=".4" filter="url(#glow-m)"'));
  out.push(poly([[x + w * 0.32, base], [x + w / 2, base - h * 0.62], [x + w * 0.68, base]], WINDOW));
  out.push(poly([[x + w * 0.4, base - h * 0.2], [x + w / 2, base - h * 0.52], [x + w * 0.6, base - h * 0.2]], WINDOW_HOT, ' opacity=".6"'));
  return out.join('');
}

/** A sagging string of bulbs between two points. */
export function festoon(a, b, sag, bulbs, rand, colours = ['#ffd27a', '#ff9ec4', '#ffe9b8'], wire = '#15112e') {
  const out = [];
  const path = [];
  for (let i = 0; i <= 30; i += 1) {
    const t = i / 30;
    path.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + Math.sin(t * Math.PI) * sag]);
  }
  out.push(line(path, wire, 1.2, ' opacity=".9"'));
  for (let i = 1; i < bulbs; i += 1) {
    const [x, y] = path[Math.round((i / bulbs) * 30)];
    const c = colours[Math.floor(rand() * colours.length)];
    out.push(circle(x, y + 2, 4.5, c, ' opacity=".3" filter="url(#glow-s)"'));
    out.push(circle(x, y + 2, 1.7, c));
  }
  return out.join('');
}

/** Snow drift: a filled shape under a crest, with a lit rim and a shade band under it. */
export function drift(crest, fill, rim, shade, rand) {
  const out = [];
  const last = crest[crest.length - 1];
  out.push(poly([[crest[0][0], 1020], ...crest, [last[0], 1020]], fill));
  out.push(line(crest, rim, 2.2, ' opacity=".75"'));
  const under = crest.map(([x, y], i) => [x, y + 8 + (i % 2) * 3 + rand() * 3]);
  out.push(poly([...crest, ...under.slice().reverse()], shade, ' opacity=".5"'));
  return out.join('');
}

/** Warm light pooled on the snow under a window or a lamp. */
export function pool(x, y, r, colour = '#ffb86b') {
  return `<ellipse cx="${x}" cy="${y}" rx="${r * 1.7}" ry="${r * 0.26}" fill="${colour}" opacity=".22" filter="url(#glow-m)"/>`;
}

/** Near log cabin on the right; returns markup and the chimney top. */
export function cabin(x, base) {
  const out = [];
  const w = 250;
  const h = 118;
  const top = base - h;
  out.push(pool(x + w * 0.45, base + 12, 150));
  out.push(rect(x, top, w, h, '#3a2540'));
  for (let i = 1; i < 8; i += 1) out.push(rect(x, top + i * 14.5, w, 1.6, '#24172f', ' opacity=".85"'));
  out.push(rect(x + w * 0.62, top, w * 0.38, h, '#000000', ' opacity=".12"'));
  out.push(rect(x + w * 0.7, top - 66, 26, 58, '#2c1d33'));
  out.push(rect(x + w * 0.7 - 3, top - 70, 32, 8, '#493247'));
  out.push(poly([[x - 26, top + 6], [x + w / 2, top - 74], [x + w + 26, top + 6]], '#1c1438'));
  out.push(poly([[x - 26, top + 6], [x + w / 2, top - 74], [x + w / 2, top - 58], [x - 6, top + 2]], '#c7bbe8'));
  out.push(poly([[x + w / 2, top - 74], [x + w + 26, top + 6], [x + w + 12, top + 10], [x + w / 2 + 6, top - 56]], '#ffe0c0'));
  const win = (wx, wy, ww, wh) => {
    out.push(rect(wx - ww * 0.2, wy - wh * 0.2, ww * 1.4, wh * 1.4, '#ffb04a', ' opacity=".5" filter="url(#glow-m)"'));
    out.push(rect(wx - 3, wy - 3, ww + 6, wh + 6, '#1d1330'));
    out.push(rect(wx, wy, ww, wh, WINDOW));
    out.push(rect(wx, wy, ww, wh * 0.3, WINDOW_HOT, ' opacity=".6"'));
    out.push(rect(wx + ww / 2 - 1, wy, 2, wh, '#6b3b2a', ' opacity=".7"'));
    out.push(rect(wx, wy + wh / 2 - 1, ww, 2, '#6b3b2a', ' opacity=".7"'));
  };
  win(x + 26, top + 26, 54, 48);
  win(x + 100, top + 26, 40, 48);
  out.push(rect(x + 168, top + 24, 46, h - 24, '#1d1330'));
  out.push(rect(x + 172, top + 28, 38, h - 28, '#f3a64c'));
  out.push(rect(x + 172, top + 28, 38, 14, WINDOW_HOT, ' opacity=".5"'));
  out.push(rect(x + 14, base - 4, w - 28, 8, '#241830'));
  for (let i = 0; i < 5; i += 1) out.push(rect(x + w + 8 + (i % 3) * 11, base - 18 - Math.floor(i / 3) * 10, 10, 9, '#6a432f'));
  return { svg: out.join(''), chimney: [x + w * 0.7 + 13, top - 70] };
}

/** Lamp post with a soft cone of light. */
export function lamp(x, base) {
  return [
    pool(x, base + 6, 70, '#ffd08a'),
    rect(x - 1.4, base - 118, 2.8, 118, '#15112e'),
    rect(x - 7, base - 124, 14, 4, '#15112e'),
    poly([[x - 12, base - 118], [x + 12, base - 118], [x + 7, base - 106], [x - 7, base - 106]], '#2a2146'),
    circle(x, base - 112, 20, '#ffd08a', ' opacity=".5" filter="url(#glow-m)"'),
    rect(x - 5, base - 114, 10, 8, WINDOW_HOT),
  ].join('');
}

export function village(rand) {
  const out = [];
  const smoke = [];
  const lots = [
    [560, 762, 36, 32], [606, 766, 46, 38], [666, 760, 32, 29], [712, 770, 54, 44],
    [796, 772, 42, 36], [848, 766, 34, 31], [894, 776, 60, 48], [970, 770, 38, 33],
  ];
  lots.forEach(([x, base, w, h], i) => {
    const c = chalet(x, base, w, h, rand, { windows: w > 36 ? 3 : 2, chimney: i % 2 === 0 });
    out.push(c.svg);
    if (c.chimney) smoke.push(c.chimney);
  });
  out.push(aFrame(772, 776, 30, 42));
  out.push(festoon([610, 750], [696, 754], 8, 9, rand));
  out.push(festoon([752, 758], [810, 760], 7, 6, rand));
  out.push(festoon([870, 760], [940, 764], 7, 7, rand));
  return { svg: out.join(''), smoke };
}
