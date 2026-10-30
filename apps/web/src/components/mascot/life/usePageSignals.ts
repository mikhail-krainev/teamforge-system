import { useCallback, useEffect, useRef } from 'react';
import type { PointerState } from './engine';

/** Smoothing for the cursor speed (0..1, higher follows faster). */
const VELOCITY_SMOOTHING = 0.35;

export interface PageSignals {
  pointer: PointerState;
  lastScrollAt: number;
  lastInputAt: number;
  /** Scrolls before this time are his own (peeking), not the reader's. */
  ownScrollUntil: number;
}

type Listeners = [EventTarget, string, EventListener][];

function pointerListener(state: PageSignals, fine: MediaQueryList): EventListener {
  let lastMoveAt = performance.now();
  let lastClientX = 0;
  return (event) => {
    const move = event as PointerEvent;
    const now = performance.now();
    const vx = (move.clientX - lastClientX) / Math.max(1, now - lastMoveAt);
    const pointer = state.pointer;
    pointer.vx += (vx - pointer.vx) * VELOCITY_SMOOTHING;
    pointer.x = move.clientX + window.scrollX;
    pointer.y = move.clientY + window.scrollY;
    pointer.movedAt = now;
    pointer.canGrab = fine.matches && move.pointerType === 'mouse';
    lastMoveAt = now;
    lastClientX = move.clientX;
    state.lastInputAt = now;
  };
}

function listenersFor(state: PageSignals): Listeners {
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
  const onLeave = (event: Event) => {
    if (!(event as MouseEvent).relatedTarget) state.pointer.canGrab = false;
  };
  const onScroll = () => {
    const now = performance.now();
    if (now < state.ownScrollUntil) return;
    state.lastScrollAt = now;
    state.lastInputAt = now;
  };
  const onInput = () => {
    state.lastInputAt = performance.now();
  };
  return [
    [window, 'pointermove', pointerListener(state, fine)],
    [document, 'mouseout', onLeave],
    [window, 'scroll', onScroll],
    [window, 'keydown', onInput],
    [window, 'pointerdown', onInput],
  ];
}

/** Collects what the reader does (cursor, scroll, keys) into a ref the animation loop reads. */
export function usePageSignals() {
  const signals = useRef<PageSignals>({
    pointer: { x: 0, y: 0, vx: 0, movedAt: -Infinity, canGrab: false },
    lastScrollAt: 0,
    lastInputAt: 0,
    ownScrollUntil: 0,
  });

  useEffect(() => {
    const listeners = listenersFor(signals.current);
    listeners.forEach(([target, type, fn]) => target.addEventListener(type, fn, { passive: true }));
    return () => listeners.forEach(([target, type, fn]) => target.removeEventListener(type, fn));
  }, []);

  /** Scrolls the page a little on his own; the scroll does not count as the reader's. */
  const scrollByHimself = useCallback((top: number, durationMs: number) => {
    signals.current.ownScrollUntil = performance.now() + durationMs;
    window.scrollBy({ top, behavior: 'smooth' });
  }, []);

  return { signals, scrollByHimself };
}
