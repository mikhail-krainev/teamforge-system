// Land under the peaks: the far city with its glow, forested foothills, a floodlit piste and a chair lift.
import { between, circle, lerp, line, pick, poly, rect } from './lib.mjs';
import { H } from './sky.mjs';
import { tinyPine } from './trees.mjs';

/** Ridge polyline through control points, with small noise between them; x runs left to right. */
export function ridge(controls, rand, { step = 14, noise = 3 } = {}) {
  const out = [];
  for (let i = 0; i < controls.length - 1; i += 1) {
    const [x0, y0] = controls[i];
    const [x1, y1] = controls[i + 1];
    const n = Math.max(1, Math.round((x1 - x0) / step));
    for (let s = 0; s < n; s += 1) {
      const t = s / n;
      out.push([lerp(x0, x1, t), lerp(y0, y1, t) + (s === 0 ? 0 : (rand() - 0.5) * noise)]);
    }
  }
  out.push(controls[controls.length - 1]);
  return out;
}

export const heightAt = (ridgePts, x) => {
  for (let i = 0; i < ridgePts.length - 1; i += 1) {
    const [x0, y0] = ridgePts[i];
    const [x1, y1] = ridgePts[i + 1];
    if (x >= x0 && x <= x1) return lerp(y0, y1, (x - x0) / (x1 - x0 || 1));
  }
  return ridgePts[ridgePts.length - 1][1];
};

export const fillBelow = (ridgePts, colour) =>
  poly([[ridgePts[0][0], H + 10], ...ridgePts, [ridgePts[ridgePts.length - 1][0], H + 10]], colour);

/** The far city: glow, silhouettes, windows, a highway of headlights. Sits behind the foothills. */
export function city(rand) {
  const out = [];
  out.push('<ellipse cx="290" cy="716" rx="330" ry="38" fill="#ff8d63" opacity=".5" filter="url(#glow-l)"/>');
  out.push('<ellipse cx="290" cy="718" rx="190" ry="20" fill="#ffc27d" opacity=".5" filter="url(#glow-m)"/>');

  const towers = [];
  const baseY = 724;
  let x = 20;
  while (x < 585) {
    const centre = 1 - Math.abs(x - 300) / 300;
    const w = between(rand, 6, 16);
    const h = between(rand, 12, 22) + Math.max(0, centre) * between(rand, 6, 44);
    out.push(rect(x, baseY - h, w, h + 6, rand() < 0.5 ? '#2a2150' : '#332759'));
    const cols = Math.floor(w / 4);
    const rows = Math.floor(h / 5);
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        if (rand() < 0.5) out.push(rect(x + 1.5 + c * 4, baseY - h + 3 + r * 5, 1.6, 1.8, rand() < 0.15 ? '#fff1d0' : '#ffbf5f'));
      }
    }
    if (h > 46 && towers.length < 4) {
      out.push(rect(x + w / 2 - 0.5, baseY - h - 9, 1, 9, '#2a2150'));
      towers.push([x + w / 2, baseY - h - 10]);
    }
    x += w + between(rand, 0.5, 3);
  }
  return { svg: out.join(''), towers };
}

/** Road of cars winding from the city to the resort: static dashes of headlights and tail lights. */
export const ROAD = 'M560 726 C 620 728, 660 742, 720 750 S 820 764, 880 774';

/** Foothill with a far forest on its crest and slopes; `skip` can keep trees off the piste. */
export function forestHill(controls, rand, { ground, tree, density, size, skip = () => false }) {
  const ridgePts = ridge(controls, rand, { step: 18, noise: 4 });
  const out = [fillBelow(ridgePts, ground)];
  const x0 = controls[0][0];
  const x1 = controls[controls.length - 1][0];
  for (let x = x0; x < x1; x += 1 / density) {
    const top = heightAt(ridgePts, x);
    const y = top + between(rand, 0, 1) ** 2 * 60;
    if (skip(x, y)) continue;
    out.push(tinyPine(x + between(rand, -2, 2), y + size * 0.5, between(rand, size * 0.7, size * 1.25), tree()));
  }
  return { svg: out.join(''), ridgePts };
}

/** Floodlit piste: a pale corridor on the hill with groomer stripes and lamp poles. */
export const PISTE = [
  [1475, 598],
  [1395, 636],
  [1330, 668],
  [1290, 708],
  [1220, 738],
  [1130, 762],
];

export function pistePoint(t) {
  const x = PISTE.length - 1;
  const i = Math.min(x - 1, Math.floor(t * x));
  const f = t * x - i;
  return [lerp(PISTE[i][0], PISTE[i + 1][0], f), lerp(PISTE[i][1], PISTE[i + 1][1], f)];
}

export const onPiste = (x, y) => {
  for (let t = 0; t <= 1; t += 0.02) {
    const [px, py] = pistePoint(t);
    if (Math.hypot((x - px) * 0.8, (y - py) * 1.6) < 30 + t * 34) return true;
  }
  return false;
};

export function piste() {
  const out = [];
  const left = [];
  const right = [];
  for (let s = 0; s <= 24; s += 1) {
    const t = s / 24;
    const [px, py] = pistePoint(t);
    const w = 22 + t * 36 + Math.sin(t * 9) * 4;
    left.push([px - w, py + Math.sin(t * 7) * 2]);
    right.push([px + w, py - Math.sin(t * 6) * 2]);
  }
  out.push(poly([...left, ...right.reverse()], '#5d5499'));
  const mid = [];
  for (let s = 0; s <= 24; s += 1) {
    const [px, py] = pistePoint(s / 24);
    mid.push([px + 8, py + 1]);
  }
  for (let k = -3; k <= 3; k += 1) {
    out.push(line(mid.map(([x, y], i) => [x + k * (4 + i * 0.7), y + k * 0.8]), '#a396d6', 1.2, ' opacity=".5"'));
  }
  out.push(line(mid.slice(8).map(([x, y]) => [x + 6, y - 2]), '#ffd9ac', 18, ' opacity=".16"'));
  const poles = [];
  for (let s = 1; s < 8; s += 1) {
    const t = s / 8;
    const [px, py] = pistePoint(t);
    const w = 22 + t * 36;
    const side = s % 2 ? -1 : 1;
    const x = px + side * (w + 5);
    out.push(rect(x - 0.6, py - 14, 1.2, 14, '#1a1636'));
    out.push(circle(x, py - 14, 5.5, '#ffd9a0', ' opacity=".2"'));
    out.push(circle(x, py - 14, 1.8, '#fff4d8'));
    poles.push([x, py - 14]);
  }
  return out.join('');
}

export const LIFT = { bottom: [1105, 756], top: [1500, 566], towers: [0.22, 0.46, 0.7, 0.9] };

/** Chair lift: tower posts and the cable. Chairs travel in the animated layer. */
export function lift() {
  const [bx, by] = LIFT.bottom;
  const [tx, ty] = LIFT.top;
  const out = [];
  const cable = (dy) => line([[bx, by - 22 + dy], [tx, ty - 22 + dy]], '#16122f', 1.1, ' opacity=".85"');
  out.push(cable(0), cable(8));
  LIFT.towers.forEach((t) => {
    const x = lerp(bx, tx, t);
    const y = lerp(by, ty, t) - 22;
    out.push(line([[x, y + 22], [x, y - 3]], '#16122f', 1.8));
    out.push(line([[x - 5, y - 3], [x + 5, y + 7]], '#16122f', 1.4));
  });
  out.push(rect(bx - 8, by - 28, 16, 28, '#1b1738'));
  out.push(poly([[bx - 11, by - 28], [bx, by - 36], [bx + 11, by - 28]], '#2b2552'));
  out.push(rect(bx - 4, by - 22, 5, 5, '#ffc561'));
  out.push(rect(tx - 7, ty - 28, 14, 28, '#1b1738'));
  out.push(poly([[tx - 10, ty - 28], [tx, ty - 35], [tx + 10, ty - 28]], '#2b2552'));
  return out.join('');
}

export function paletteTree(rand, colours) {
  return () => pick(rand, colours);
}
