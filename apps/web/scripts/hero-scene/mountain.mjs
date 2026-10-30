// Faceted snow mountain, drawn the way an illustrator would: a few large planes cut by straight
// creases, one sun direction (low, from the right), snow lines that run diagonally across each
// plane, rock ribs that point up the fall line and a thin lit arete on the sunward edge.
import { between, clamp, lerp, mix, poly, ramp } from './lib.mjs';

const SNOW = ['#3a3d8c', '#6a63a8', '#c59ac0', '#ffc9a3', '#fff0dc'];
const ROCK = ['#171433', '#2a2144', '#5a3550', '#a4604f'];
const RIM = '#ffd79a';
const SAMPLES = 16;
const LAST = SAMPLES - 1;

/** One side of the silhouette as samples from apex to base: steep at the top, flaring below. */
function side(apex, base, { bend, rough }, rand) {
  const span = base[0] - apex[0];
  const out = [];
  let tooth = 0;
  for (let i = 0; i < SAMPLES; i += 1) {
    const t = i / LAST;
    const edge = i === 0 || i === LAST ? 0 : 1;
    if (i > 2 && rand() < 0.22) tooth = (rand() < 0.5 ? -1 : 1) * rough * Math.abs(span);
    tooth *= 0.5;
    out.push([apex[0] + span * t ** bend + tooth * edge, lerp(apex[1], base[1], t)]);
  }
  return out;
}

/** Creases between the two sides; they bend a little but never cross. */
function creases(left, right, count, rand) {
  const lines = [left];
  for (let k = 1; k < count; k += 1) {
    lines.push(
      left.map(([lx, y], i) => {
        const rx = right[i][0];
        const gap = (rx - lx) / count;
        const wob = i === 0 ? 0 : (rand() - 0.5) * gap * 0.55;
        return [lerp(lx, rx, k / count) + wob, y];
      }),
    );
  }
  lines.push(right);
  return lines;
}

const at = (a, b, u, i) => [lerp(a[i][0], b[i][0], u), lerp(a[i][1], b[i][1], u)];

/** Strip of a face between fractions u0..u1, from sample `from` to `to`. */
function strip(a, b, u0, u1, from, to) {
  const top = [];
  const bottom = [];
  for (let i = from; i <= to; i += 1) {
    top.push(at(a, b, u0, i));
    bottom.push(at(a, b, u1, i));
  }
  return [...top, ...bottom.reverse()];
}

function faceLight(k, count, centre, rand, sunward) {
  const sun = 1 / (1 + Math.exp(-((k + 0.5 - centre * count) / (count * 0.12))));
  let l = 0.1 + sunward * 0.84 * sun;
  if (k % 3 === 1 && rand() < 0.5) l *= 0.55;
  return clamp(l + (rand() - 0.5) * 0.08, 0, 1);
}

/** Snow on one half of a face; its lower edge is one diagonal with a single notch. */
function snow(a, b, [u0, u1], tone, iL, iR, haze, rand) {
  const upL = [];
  const upR = [];
  for (let i = 0; i <= iL; i += 1) upL.push(at(a, b, u0, i));
  for (let i = 0; i <= iR; i += 1) upR.push(at(a, b, u1, i));
  const um = lerp(u0, u1, between(rand, 0.35, 0.65));
  const im = Math.round(lerp(iL, iR, 0.5) + (rand() < 0.5 ? 2 : -1));
  return poly([...upL, at(a, b, um, clamp(im, 2, LAST)), ...upR.reverse()], haze(ramp(SNOW, tone)));
}

/** Rock rib: a narrow wedge climbing the fall line out of the rock into the snow. */
function rib(a, b, u, iFoot, height, width, tone, haze) {
  const i0 = Math.max(1, iFoot - height);
  const foot = [at(a, b, clamp(u - width, 0, 1), iFoot), at(a, b, clamp(u + width, 0, 1), iFoot)];
  return poly([at(a, b, u, i0), foot[1], foot[0]], haze(ramp(ROCK, tone)), ' opacity=".9"');
}

function face(a, b, l, haze, detail, rand) {
  const out = [poly(strip(a, b, 0, 1, 0, LAST), haze(ramp(ROCK, l * 0.85)))];
  const base = Math.round(between(rand, 0.26, 0.56) * LAST);
  const tilt = Math.round(between(rand, -3, 3));
  const split = between(rand, 0.4, 0.6);
  out.push(snow(a, b, [0, split], l - 0.07, clamp(base + tilt, 3, LAST), clamp(base - tilt, 3, LAST), haze, rand));
  out.push(snow(a, b, [split, 1], l + 0.08, clamp(base - tilt, 3, LAST), clamp(base + tilt, 3, LAST), haze, rand));
  if (!detail) return out;
  const ribs = 1 + Math.round(rand());
  for (let r = 0; r < ribs; r += 1) {
    out.push(rib(a, b, between(rand, 0.2, 0.8), base + 1, 2 + Math.round(rand() * 3), between(rand, 0.03, 0.06), l * 0.6, haze));
  }
  if (l > 0.3 && rand() < 0.55) {
    const u0 = between(rand, 0.05, 0.5);
    const i0 = Math.round(between(rand, 0.15, 0.4) * LAST);
    out.push(poly(strip(a, b, u0, Math.min(1, u0 + between(rand, 0.25, 0.45)), i0, Math.min(LAST, i0 + 5)), '#2a2160', ' opacity=".26"'));
  }
  return out;
}

/** Lit arete: a thin sliver along the sunward silhouette, strongest near the top. */
function arete(right, ridge, haze) {
  const n = Math.round(SAMPLES * 0.62);
  const outer = right.slice(0, n);
  const inner = outer.map(([x, y], i) => [lerp(x, ridge[i][0], 0.18), y]);
  return poly([...outer, ...inner.reverse()], haze(RIM), ' opacity=".8"');
}

/**
 * @param {object} o
 * @param {[number, number]} o.apex
 * @param {[number, number]} o.baseL
 * @param {[number, number]} o.baseR
 * @param {() => number} o.rand
 * @param {number} [o.ridges]   large planes across the mountain
 * @param {number} [o.centre]   where the light turns, 0 = left foot, 1 = right foot
 * @param {number} [o.sunward]  0..1 how much of the sun the right planes catch
 * @param {string} [o.fog]      colour of the air in front of the mountain
 * @param {number} [o.fogAmount] 0..1
 * @param {boolean} [o.detail]  rock ribs, cast shadows and the lit arete
 */
export function mountain(o) {
  const { apex, baseL, baseR, rand, ridges = 8, centre = 0.5, sunward = 1 } = o;
  const { fog = '#2b2a66', fogAmount = 0, detail = true } = o;
  const haze = (c) => (fogAmount > 0 ? mix(c, fog, fogAmount) : c);
  const left = side(apex, baseL, { bend: o.bendL ?? 1.45, rough: o.rough ?? 0.012 }, rand);
  const right = side(apex, baseR, { bend: o.bendR ?? 1.3, rough: o.rough ?? 0.012 }, rand);
  const lines = creases(left, right, ridges, rand);
  const out = [poly([...left, ...right.slice().reverse()], haze(ROCK[0]))];
  for (let k = 0; k < ridges; k += 1) {
    out.push(...face(lines[k], lines[k + 1], faceLight(k, ridges, centre, rand, sunward), haze, detail, rand));
  }
  if (detail) out.push(arete(right, lines[ridges - 1], haze));
  return out.join('');
}
