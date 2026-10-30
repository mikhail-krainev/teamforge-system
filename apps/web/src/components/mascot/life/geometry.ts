import type { Ledge, Point, View } from './types';

/** Keeps him off the very corners of a block. */
const LEDGE_INSET_PX = 48;
/** He moves on when his block leaves this band of the viewport (fractions of its height). */
const KEEP_BAND = [0.06, 0.94] as const;
/** New blocks are picked from this band, nearest to the target line. */
const PICK_BAND = [0.14, 0.86] as const;
const TARGET_LINE = 0.62;
/** He is home only while the page is (almost) at the top: any real scroll sends him out. */
const HOME_SCROLL_PX = 48;

/** Pages without marked blocks: he walks on their cards, headers and the footer. */
const FALLBACK_LEDGES =
  '.shell-content .page-head, .shell-content .card:not(.nested), .shell-content .block, .footer-inner';
const MIN_LEDGE_WIDTH_PX = 120;
/** Where his floor is when no block is on screen: feet near the bottom of the viewport. */
const FLOOR_LINE = 0.96;
/** Id of the floor ledge; block ids start at 1. */
export const FLOOR_ID = 0;

/** Ids follow the node, so a block keeps its id while others come and go (client navigation). */
const ledgeIds = new WeakMap<Element, number>();
let nextLedgeId = FLOOR_ID + 1;

function idOf(node: Element): number {
  let id = ledgeIds.get(node);
  if (id === undefined) {
    id = nextLedgeId++;
    ledgeIds.set(node, id);
  }
  return id;
}

export function measureLedges(scrollY: number): Ledge[] {
  const marked = document.querySelectorAll<HTMLElement>('[data-yeti-ledge]');
  const nodes =
    marked.length > 0 ? marked : document.querySelectorAll<HTMLElement>(FALLBACK_LEDGES);
  return [...nodes].flatMap((node) => {
    const rect = node.getBoundingClientRect();
    if (rect.width < MIN_LEDGE_WIDTH_PX || rect.height === 0) return [];
    return [{ id: idOf(node), left: rect.left, right: rect.right, top: rect.top + scrollY }];
  });
}

/** A floor along the bottom of the screen, so he stays in view where no block is. */
export function floorLedge(view: View): Ledge {
  return {
    id: FLOOR_ID,
    left: 0,
    right: view.width,
    top: view.scrollY + view.height * FLOOR_LINE,
  };
}

/** Feet position and size of the hero mascot, or null when the slot is not on the page. */
export function measureSlot(scrollY: number): { feet: Point; size: number } | null {
  const node = document.querySelector<HTMLElement>('.hero-yeti-slot .live-yeti-button');
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return { feet: { x: rect.left + rect.width / 2, y: rect.bottom + scrollY }, size: rect.width };
}

export function isHomeInView(view: View): boolean {
  return view.scrollY < HOME_SCROLL_PX;
}

function inBand(y: number, view: View, band: readonly [number, number]): boolean {
  const rel = (y - view.scrollY) / view.height;
  return rel >= band[0] && rel <= band[1];
}

/** The block he should stand on: the current one while it is comfortably visible. */
export function pickLedge(ledges: readonly Ledge[], view: View, current: Ledge | null) {
  if (current && inBand(current.top, view, KEEP_BAND)) {
    return ledges.find((ledge) => ledge.id === current.id) ?? current;
  }
  const line = view.scrollY + view.height * TARGET_LINE;
  let best: Ledge | null = null;
  let nearest: Ledge | null = null;
  const closer = (a: Ledge, b: Ledge | null) =>
    !b || Math.abs(a.top - line) < Math.abs(b.top - line);
  for (const ledge of ledges) {
    // Off-band ledges are only a fallback for long gaps between blocks.
    if (closer(ledge, nearest) && inBand(ledge.top, view, [0, 1])) nearest = ledge;
    if (inBand(ledge.top, view, PICK_BAND) && closer(ledge, best)) best = ledge;
  }
  return best ?? nearest ?? current;
}

/** The ledge right under x (for falling off the cursor), nearest to y. */
export function ledgeBelow(ledges: readonly Ledge[], x: number, y: number): Ledge | null {
  let best: Ledge | null = null;
  for (const ledge of ledges) {
    if (x < ledge.left || x > ledge.right || ledge.top < y) continue;
    if (!best || ledge.top < best.top) best = ledge;
  }
  return best;
}

export function clampToLedge(ledge: Ledge, x: number): number {
  const min = ledge.left + LEDGE_INSET_PX;
  const max = ledge.right - LEDGE_INSET_PX;
  return min > max ? (ledge.left + ledge.right) / 2 : Math.min(max, Math.max(min, x));
}

/** A spot on the ledge near where he comes from, so jumps stay short and readable. */
export function landingSpot(ledge: Ledge, fromX: number): Point {
  const nudge = (Math.random() - 0.5) * 120;
  return { x: clampToLedge(ledge, fromX + nudge), y: ledge.top };
}

export function isVisible(point: Point, view: View, margin = 40): boolean {
  return point.y > view.scrollY - margin && point.y < view.scrollY + view.height + margin;
}
