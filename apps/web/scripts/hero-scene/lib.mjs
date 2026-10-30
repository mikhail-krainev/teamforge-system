// Small helpers for the hero scene generator: seeded random, colour maths, SVG string builders.

/** Deterministic random in [0, 1): the same seed always paints the same scene. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const num = (v) => Math.round(v * 10) / 10;

export function between(rand, lo, hi) {
  return lo + rand() * (hi - lo);
}

export function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

function toRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

export function mix(a, b, t) {
  const [ar, ag, ab] = toRgb(a);
  const [br, bg, bb] = toRgb(b);
  const ch = (x, y) =>
    Math.round(lerp(x, y, clamp(t, 0, 1)))
      .toString(16)
      .padStart(2, '0');
  return `#${ch(ar, br)}${ch(ag, bg)}${ch(ab, bb)}`;
}

/** Colour along a list of stops, t in [0, 1]. */
export function ramp(stops, t) {
  const x = clamp(t, 0, 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  return mix(stops[i], stops[i + 1], x - i);
}

export const pts = (list) => list.map(([x, y]) => `${num(x)},${num(y)}`).join(' ');

export function poly(list, fill, extra = '') {
  return `<polygon points="${pts(list)}" fill="${fill}"${extra}/>`;
}

export function rect(x, y, w, h, fill, extra = '') {
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="${fill}"${extra}/>`;
}

export function circle(x, y, r, fill, extra = '') {
  return `<circle cx="${num(x)}" cy="${num(y)}" r="${num(r)}" fill="${fill}"${extra}/>`;
}

export function line(list, stroke, width, extra = '') {
  return `<polyline points="${pts(list)}" fill="none" stroke="${stroke}" stroke-width="${num(width)}" stroke-linejoin="round" stroke-linecap="round"${extra}/>`;
}

export const group = (body, attrs = '') => `<g${attrs ? ` ${attrs}` : ''}>${body.join('')}</g>`;
