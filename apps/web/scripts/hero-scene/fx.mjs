// Moving layer drawn over the static scene with the same viewBox: snow, smoke, twinkling stars,
// cars on the highway, chairs on the lift. Only transform and opacity animate, and
// every animation sits behind prefers-reduced-motion: no-preference.
import { between, circle, num } from './lib.mjs';
import { LIFT, ROAD } from './land.mjs';
import { H, W } from './sky.mjs';

export const CSS = `
.tw{animation:tw var(--d,4s) ease-in-out var(--l,0s) infinite alternate}
.fall{animation:fall var(--d) linear infinite}
.sway{animation:sway var(--s) ease-in-out infinite alternate}
.puff{transform-box:fill-box;transform-origin:center;animation:puff 7s ease-out var(--l,0s) infinite}
.blink{animation:blink 2.4s steps(1) var(--l,0s) infinite}
.car{animation:car 14s linear infinite}
.car2{animation:car 14s linear -7s infinite}
.up{animation:chair var(--c) linear infinite}
.down{animation:chair var(--c) linear infinite reverse}
.breathe{animation:breathe 5s ease-in-out infinite alternate}
@keyframes tw{from{opacity:.15}to{opacity:1}}
@keyframes fall{to{transform:translateY(1000px)}}
@keyframes sway{to{transform:translateX(34px)}}
@keyframes puff{0%{opacity:0;transform:translate(0,0) scale(.5)}15%{opacity:.4}100%{opacity:0;transform:translate(26px,-64px) scale(2.2)}}
@keyframes blink{0%{opacity:1}50%{opacity:.1}}
@keyframes car{to{stroke-dashoffset:-168}}
@keyframes chair{to{transform:translate(var(--dx),var(--dy))}}
@keyframes breathe{from{opacity:.55}to{opacity:1}}
`;

export function snowLayer(rand, count, rMin, rMax, fall, sway, opacity) {
  const flakes = [];
  for (let i = 0; i < count; i += 1) {
    const x = between(rand, -20, W + 20);
    const y = between(rand, 0, H);
    const r = between(rand, rMin, rMax);
    flakes.push(circle(x, y, r, '#ffffff'), circle(x, y - H, r, '#ffffff'));
  }
  return `<g opacity="${opacity}" class="sway" style="--s:${sway}s"><g class="fall" style="--d:${fall}s">${flakes.join('')}</g></g>`;
}

export function chairs(from, to, gap, cls, dy) {
  const [fx, fy] = from;
  const [tx, ty] = to;
  const len = Math.hypot(tx - fx, ty - fy);
  const ux = (tx - fx) / len;
  const uy = (ty - fy) / len;
  const items = [];
  for (let d = -gap; d < len + gap; d += gap) {
    const x = fx + ux * d;
    const y = fy + uy * d + dy;
    items.push(
      `<g><path d="M${num(x)} ${num(y)}v7" stroke="#16122f" stroke-width="1"/><rect x="${num(x - 3)}" y="${num(y + 7)}" width="6" height="3" fill="#1b1738"/><circle cx="${num(x)}" cy="${num(y + 5)}" r="1.1" fill="#ffd9a0"/></g>`,
    );
  }
  return `<g class="${cls}" style="--c:5s;--dx:${num(ux * gap)}px;--dy:${num(uy * gap)}px">${items.join('')}</g>`;
}

/** @param {{ smoke: [number, number][], towers: [number, number][], cabinChimney: [number, number] }} a */
export function fx(rand, a) {
  const cableFrom = [LIFT.bottom[0], LIFT.bottom[1] - 22];
  const cableTo = [LIFT.top[0], LIFT.top[1] - 22];
  const out = [`<style>@media (prefers-reduced-motion:no-preference){${CSS}}</style>`];

  const stars = [];
  for (let i = 0; i < 26; i += 1) {
    const r = between(rand, 0.9, 1.9);
    stars.push(`<g class="tw" style="--d:${num(between(rand, 2.2, 6))}s;--l:-${num(between(rand, 0, 5))}s">${circle(between(rand, 0, W), Math.pow(rand(), 1.6) * 380, r, '#fff6e6')}</g>`);
  }
  out.push(stars.join(''));

  out.push(`<path class="car" d="${ROAD}" fill="none" stroke="#fff4d0" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="0.1 14"/>`);
  out.push(`<path class="car2" d="${ROAD}" transform="translate(0 4)" fill="none" stroke="#ff6a4a" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="0.1 14"/>`);

  a.towers.forEach(([x, y], i) => {
    out.push(`<g class="blink" style="--l:-${i * 0.7}s">${circle(x, y, 2.2, '#ff4a3a')}${circle(x, y, 6, '#ff4a3a', ' opacity=".25"')}</g>`);
  });

  out.push(
    `<clipPath id="liftclip"><rect x="${LIFT.bottom[0]}" y="0" width="${LIFT.top[0] - LIFT.bottom[0]}" height="${H}"/></clipPath>`,
    `<g clip-path="url(#liftclip)">${chairs(cableFrom, cableTo, 46, 'up', 0)}${chairs(cableFrom, cableTo, 46, 'down', 8)}</g>`,
  );

  [...a.smoke, a.cabinChimney].forEach(([x, y], i) => {
    const big = i === a.smoke.length;
    for (let p = 0; p < 3; p += 1) {
      out.push(`<g class="puff" style="--l:-${p * 2.3}s">${circle(x, y, big ? 9 : 4.5, '#d9d0f2')}</g>`);
    }
  });

  out.push(snowLayer(rand, 34, 0.9, 1.6, 34, 9, 0.55), snowLayer(rand, 26, 1.6, 2.6, 22, 7, 0.75), snowLayer(rand, 12, 2.8, 4.2, 14, 6, 0.85));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice">${out.join('')}</svg>`;
}
